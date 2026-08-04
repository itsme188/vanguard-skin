# IBKR Ledger Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the incomplete canonical-csv IBKR backfill (batch 17, 2024-01→2026-03) with a truthful ledger rebuilt from real IBKR activity statements, including the Jan-2024 Robinhood ACATS in-kind positions with worksheet-verified cost basis, so ledger-reconstructed positions match broker-reported holdings.

**Architecture:** Two small capability additions (parser reads the statement `Transfers` section → `TRANSFER_IN`/`TRANSFER_OUT` rows; `computeTaxLots` treats security `TRANSFER_IN` as lot-creating), one curated one-time repair (replace the 4 auto ACATS rows with 8 original lots extracted from the IBKR Form 8949 worksheet), then a driver script that backs up the DB, retires batch 17, re-imports 6 statement files through the native parser, and recomputes. A verification script turns the audit's ledger-vs-broker gap test into the acceptance gate.

**Tech Stack:** TypeScript, better-sqlite3, Vitest (in-memory DBs, DI pattern), existing `lib/import` pipeline (`parseImport`/`commitImport`/`undoImport`).

## Global Constraints

- Every DB function takes `db: Database.Database` (DI for `:memory:` tests).
- Deterministic `source_key` on every imported record — re-import is a no-op.
- Transaction types are UPPERCASE; parsers output positive quantities (type carries direction).
- Data integrity: NEVER fabricate dates/prices — every number in this plan comes from the statement files or the IBKR 8949 worksheet.
- Scripts that mutate live data: dry-run by default, `--apply` to execute (repo convention).
- `rm -rf` never with relative paths. No commits until session end (user directive 2026-08-03).
- Run `npx vitest run` (full suite) before declaring any task complete.

## Context for implementers (audit findings, 2026-08-03)

- The whole 2024-01→2026-03 IBKR ledger is ONE canonical batch: `import_batches.id = 17` (`dashboard_IBKR_transactions.csv`, 2,493 transactions). It omits: the ACATS in-kind position legs, at least one real fill (QQQ +642 @ 427.41 on 2026-05-02 — note: within batch 17's successor period, see below), and all option expiry rows (native parser represents expiries as `SELL_TO_CLOSE @ 0` from the Trades section, code `C;Ep`).
- Native `ibkr-activity` batches already cover Apr/May/Jun 2026 (batches 68, 88, 89, 90, 91). Their source_keys (`ibkr:trade:…`) do NOT overlap canonical keys, so batch 17 must be deleted BEFORE re-import or history doubles.
- The Jan-2024 statement `Transfers` section (the section the parser currently ignores):
  ```
  Transfers,Header,Asset Category,Currency,Account,Symbol,Date,Type,Direction,Xfer Company,Xfer Account,Qty,Xfer Price,Market Value,Realized P/L,Cash Amount,Code
  Transfers,Data,Stocks,USD,U13643679,SQQQ,2024-01-05,ACATS,In,--,118056084,"2,500",--,"37,100.00",0.00,0.00,
  Transfers,Data,Stocks,USD,U13643679,TQQQ,2024-01-05,ACATS,In,--,118056084,150,--,"6,871.50",0.00,0.00,
  Transfers,Data,Stocks,USD,U13643679,TTD,2024-01-05,ACATS,In,--,118056084,150,--,"10,260.00",0.00,0.00,
  Transfers,Data,Stocks,USD,U13643679,UCO,2024-01-05,ACATS,In,--,118056084,350,--,"9,264.50",0.00,0.00,
  Transfers,Data,Total,,,,,,,,,,,63496,0,0,
  ```
- ACATS original lots (extracted from `~/Desktop/Trading - Local/IBKR worksheet for Form 8949 2024.pdf`, verified sums match transferred quantities):

  | Symbol | Qty | Original acq date | Cost basis ($) |
  |---|---|---|---|
  | SQQQ | 100 | 2023-11-27 | 1,647.21 |
  | SQQQ | 100 | 2023-12-05 | 1,674.95 |
  | SQQQ | 500 | 2023-12-22 | 8,873.79 |
  | SQQQ | 1,800 | "VARIOUS" → use 2024-01-05 (transfer date) + note | 30,038.20 |
  | TQQQ | 150 | 2023-12-13 | 7,352.50 |
  | TTD | 50 | 2023-12-18 | 3,762.50 |
  | TTD | 100 | 2023-12-18 | 7,525.00 |
  | UCO | 200 | 2023-12-05 | 6,663.00 |
  | UCO | 150 | 2023-12-05 | 4,997.25 |

- Input files (all verified to exist; the driver preflights each for a `Trades` section + `Statement,Data,Period` line):
  1. `/Users/Yitzi/Desktop/Trading - Local/IBKR 2024 activity.csv` (Jan 1–Dec 31 2024; 640 Trades rows, 5 Transfers rows)
  2. `/Users/Yitzi/Desktop/Trading - Local/2025 Annual IBKR.csv` (Jan 1–Dec 31 2025; 1,736 Trades rows)
  3. `/Users/Yitzi/Desktop/Trading - Local/Trading/IBKR 2026-01 activity.csv`
  4. `/Users/Yitzi/Desktop/Trading - Local/Trading/2026-02 IBKR Activity Statement.csv`
  5. `/Users/Yitzi/Desktop/Trading - Local/Trading/IBKR march 26.csv`
  6. `/Users/Yitzi/Desktop/Trading - Local/july 2026 IBKR statement.csv` (Jul 1–31 2026; 180 Trades rows)
- Genuine shorts are real and correct (AAL −1000 broker-confirmed): after rebuild, residual negative holding periods should correspond ONLY to broker-confirmed short round-trips.

---

### Task 1: Parser — Transfers section → TRANSFER_IN/TRANSFER_OUT

**Files:**
- Modify: `lib/import/parsers/ibkr-activity.ts` (add a Transfers block after the Trades block, ~line 304)
- Test: `tests/import/ibkr-activity-transfers.test.ts` (create)

**Interfaces:**
- Consumes: the parser's existing `rows` array (`{section, discriminator, fields}`), `transactions` array, `securitiesMap`.
- Produces: `ParsedTransaction` entries with `type: "TRANSFER_IN" | "TRANSFER_OUT"`, positive `quantity`, `pricePerShare` = marketValue/qty, `sourceKey` = `` `ibkr:xfer:${date}:${symbol}:${qty}:${direction}` ``. Task 5's driver relies on the Jan-2024 import creating exactly 4 `TRANSFER_IN` rows with keys `ibkr:xfer:2024-01-05:SQQQ:2500:In` etc.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/import/ibkr-activity-transfers.test.ts
import { describe, it, expect } from "vitest";
import { parseIbkrActivity } from "@/lib/import/parsers/ibkr-activity";

const HEADER =
  'Statement,Header,Field Name,Field Value\n' +
  'Statement,Data,Period,"January 1, 2024 - December 31, 2024"\n';

const TRANSFERS =
  "Transfers,Header,Asset Category,Currency,Account,Symbol,Date,Type,Direction,Xfer Company,Xfer Account,Qty,Xfer Price,Market Value,Realized P/L,Cash Amount,Code\n" +
  'Transfers,Data,Stocks,USD,U13643679,SQQQ,2024-01-05,ACATS,In,--,118056084,"2,500",--,"37,100.00",0.00,0.00,\n' +
  "Transfers,Data,Stocks,USD,U13643679,TQQQ,2024-01-05,ACATS,In,--,118056084,150,--,\"6,871.50\",0.00,0.00,\n" +
  "Transfers,Data,Total,,,,,,,,,,,63496,0,0,\n";

describe("ibkr-activity Transfers section", () => {
  it("parses stock ACATS In legs as TRANSFER_IN with MV-derived price", () => {
    const result = parseIbkrActivity(HEADER + TRANSFERS);
    const xfers = result.transactions.filter((t) => t.type === "TRANSFER_IN");
    expect(xfers).toHaveLength(2);
    const sqqq = xfers.find((t) => t.symbol === "SQQQ")!;
    expect(sqqq.quantity).toBe(2500);
    expect(sqqq.tradeDate).toBe("2024-01-05");
    expect(sqqq.pricePerShare).toBeCloseTo(37100 / 2500, 6); // 14.84
    expect(sqqq.amount).toBeCloseTo(37100, 2);
    expect(sqqq.sourceKey).toBe("ibkr:xfer:2024-01-05:SQQQ:2500:In");
  });

  it("skips the Total row and non-stock rows, and maps Out direction", () => {
    const out =
      "Transfers,Header,Asset Category,Currency,Account,Symbol,Date,Type,Direction,Xfer Company,Xfer Account,Qty,Xfer Price,Market Value,Realized P/L,Cash Amount,Code\n" +
      'Transfers,Data,Stocks,USD,U13643679,ABC,2024-06-01,ACATS,Out,--,999,100,--,"1,000.00",0.00,0.00,\n' +
      "Transfers,Data,Cash,USD,U13643679,,2024-06-01,ACATS,In,--,999,,,,,500.00,\n" +
      "Transfers,Data,Total,,,,,,,,,,,1000,0,0,\n";
    const result = parseIbkrActivity(HEADER + out);
    const xfers = result.transactions.filter((t) => t.type.startsWith("TRANSFER"));
    expect(xfers).toHaveLength(1);
    expect(xfers[0].type).toBe("TRANSFER_OUT");
    expect(xfers[0].symbol).toBe("ABC");
  });
});
```

Note: check the actual exported parse-function name at the top of `ibkr-activity.ts` first (`grep -n "export" lib/import/parsers/ibkr-activity.ts`) and match the existing test file's import style (`tests/import/` has existing ibkr-activity tests — follow their fixture-building idiom if one exists).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/import/ibkr-activity-transfers.test.ts`
Expected: FAIL — 0 TRANSFER_IN rows found.

- [ ] **Step 3: Implement the Transfers block**

Insert after the Trades loop (~line 304), following the Trades block's header-name column-mapping idiom:

```typescript
// Parse Transfers (ACATS in-kind security legs). The Jan-2024 Robinhood
// ACATS positions were invisible to the old canonical backfill — every
// subsequent sale of those shares overshot the ledger (2026-08-03 audit).
// Cash legs already arrive via Deposits & Withdrawals; only security rows
// (Asset Category "Stocks") are transactions here. Basis: transfer-date
// market value / qty — refined for the 4 known ACATS positions by
// scripts/repair-acats-opening-lots.ts (worksheet-verified original lots).
const xferHeader = rows.find(
  (r) => r.section === "Transfers" && r.discriminator === "Header"
);
const xCol: Record<string, number> = {};
xferHeader?.fields.forEach((name, i) => {
  xCol[name] = i;
});
for (const row of rows) {
  if (row.section !== "Transfers" || row.discriminator !== "Data") continue;
  const assetCategory = row.fields[xCol["Asset Category"] ?? 0];
  if (assetCategory !== "Stocks") continue; // skips Total + Cash rows
  const symbol = row.fields[xCol["Symbol"] ?? 3];
  const date = row.fields[xCol["Date"] ?? 4];
  const direction = row.fields[xCol["Direction"] ?? 6];
  const qty = Math.abs(
    parseFloat((row.fields[xCol["Qty"] ?? 9] ?? "").replace(/,/g, ""))
  );
  const marketValue = Math.abs(
    parseFloat((row.fields[xCol["Market Value"] ?? 11] ?? "").replace(/,/g, ""))
  );
  if (!symbol || !date || isNaN(qty) || qty === 0) continue;

  transactions.push({
    accountName: "IBKR",
    tradeDate: date,
    type: direction === "Out" ? "TRANSFER_OUT" : "TRANSFER_IN",
    symbol,
    quantity: qty,
    amount: marketValue,
    pricePerShare: isNaN(marketValue) ? undefined : marketValue / qty,
    fees: 0,
    sourceKey: `ibkr:xfer:${date}:${symbol}:${qty}:${direction}`,
  });
  securitiesMap.set(symbol, { symbol, securityType: "Stock" });
}
```

Adjust field types to the parser's actual `ParsedTransaction` shape (check how the Trades block types `pricePerShare` — if it's `number`, use `marketValue / qty` and `continue` on NaN instead of `undefined`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/import/ibkr-activity-transfers.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Verify TRANSFER_IN survives validation + commit**

Check `lib/import/validate.ts` for the allowed-transaction-type list. If `TRANSFER_IN`/`TRANSFER_OUT` are not in it, add them (the Vanguard parser already emits these types — check how they flow). Then add one integration assertion to the new test file: run the parsed result through `commitImport` on a `:memory:` DB (copy the setup idiom from an existing `tests/import/engine.test.ts` case) and assert the transaction row lands with `type = 'TRANSFER_IN'` and the right `price_per_share`.

Run: `npx vitest run tests/import/`
Expected: PASS.

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: all green. Do NOT commit (session-end batch).

---

### Task 2: Engine — TRANSFER_IN creates tax lots

**Files:**
- Modify: `lib/compute/tax-lots.ts:79` (the lot-creating type list)
- Test: `tests/compute/tax-lots.test.ts` (existing file — add a case; if the existing tax-lot tests live under a different name, `ls tests/compute/ | grep -i "tax"` and extend that file)

**Interfaces:**
- Consumes: `transactions` rows with `type='TRANSFER_IN'`, non-NULL `quantity` + `price_per_share` (Task 1 guarantees these).
- Produces: `tax_lots` rows with `acquisition_date` = the TRANSFER_IN's `trade_date`, `cost_basis` = qty × price_per_share, `is_short` = 0. Task 4's repair rows and Task 5's rebuilt ledger rely on this.

- [ ] **Step 1: Write the failing test**

```typescript
it("creates a tax lot from a TRANSFER_IN (ACATS in-kind) transaction", () => {
  // setup idiom copied from the surrounding tests: in-memory db with
  // accounts/securities/transactions tables + one account + one security
  insertTxn(db, {
    account_id: 1, security_id: 1, trade_date: "2024-01-05",
    type: "TRANSFER_IN", quantity: 2500, price_per_share: 14.84, amount: 37100,
  });
  insertTxn(db, {
    account_id: 1, security_id: 1, trade_date: "2024-01-09",
    type: "SELL", quantity: 2500, price_per_share: 15.0, amount: 37500,
  });
  computeTaxLots(db);
  const lots = db.prepare("SELECT * FROM tax_lots").all() as any[];
  expect(lots).toHaveLength(1);
  expect(lots[0].acquisition_date).toBe("2024-01-05");
  expect(lots[0].cost_basis).toBeCloseTo(37100, 0);
  const sales = db.prepare("SELECT * FROM tax_lot_sales").all() as any[];
  expect(sales).toHaveLength(1);
  expect(sales[0].holding_period_days).toBe(4); // no more negative pairing
});
```

(Adapt `insertTxn` to whatever helper the existing tax-lot tests use — do not invent a new helper if one exists.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/compute/ -t "TRANSFER_IN"`
Expected: FAIL — 0 lots created (transfer_in not in the buys list).

- [ ] **Step 3: Implement**

In `lib/compute/tax-lots.ts` line 79, extend the lot-creating list:

```typescript
WHERE LOWER(type) IN ('buy', 'reinvestment', 'buy_to_open', 'sell_to_open', 'transfer_in')
```

And in the `isShort` line (~102), no change needed (`transfer_in` ≠ `sell_to_open` → 0). Update the comment above the query (line 73-74) to mention TRANSFER_IN = ACATS in-kind arrival. Deliberately do NOT add `transfer_out` to the sell list — outbound security transfers are the R4 donation-tracking workstream; note this in the same comment.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/compute/`
Expected: PASS.

- [ ] **Step 5: Full suite**

Run: `npx vitest run`
Expected: green. (Watch for Vanguard-side surprises: Vanguard TRANSFER_IN rows exist — e.g. VFITX 0.905 sh on 2024-01-02 — and will now create small lots. That is CORRECT behavior — those shares really arrived — but if a Vanguard reconciliation test asserts exact lot counts it may need its fixture updated, with a comment explaining the semantic change.)

---

### Task 3: Parser hardening — within-file duplicate source_key ordinal

Two genuinely identical fills (same date, symbol, qty, proceeds) collide on `ibkr:trade:` keys and the second row is silently dropped by `INSERT OR IGNORE` — annual files (1,736 trade rows) raise the odds. Mirror the canonical-csv `:#N` ordinal convention.

**Files:**
- Modify: `lib/import/parsers/ibkr-activity.ts` (wrap sourceKey assignment in both the Trades and Transfers pushes)
- Test: `tests/import/ibkr-activity-transfers.test.ts` (add a case; or the existing ibkr-activity test file)

**Interfaces:**
- Produces: first occurrence keeps the bare key (idempotent with historical imports); the Nth identical key gets `:#N` appended (N starting at 2).

- [ ] **Step 1: Write the failing test**

```typescript
it("disambiguates identical fills with an ordinal instead of dropping them", () => {
  const dupTrades =
    "Trades,Header,DataDiscriminator,Asset Category,Currency,Symbol,Date/Time,Quantity,T. Price,C. Price,Proceeds,Comm/Fee,Basis,Realized P/L,MTM P/L,Code\n" +
    'Trades,Data,Order,Stocks,USD,AAPL,"2025-03-03, 10:00:00",100,200,200,-20000,-1,20001,0,0,O\n' +
    'Trades,Data,Order,Stocks,USD,AAPL,"2025-03-03, 10:00:05",100,200,200,-20000,-1,20001,0,0,O\n';
  const result = parseIbkrActivity(HEADER + dupTrades);
  const keys = result.transactions.map((t) => t.sourceKey);
  expect(new Set(keys).size).toBe(keys.length); // all unique
  expect(keys[1]).toBe(keys[0] + ":#2");
});
```

IMPORTANT: build the fixture header to match the real single-account statement layout (no "Account" column — copy a real Trades header line from `/Users/Yitzi/Desktop/Trading - Local/2025 Annual IBKR.csv` via `grep "^Trades,Header" | head -1` and use it verbatim in the fixture).

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — `Set.size` is 1 less than length.

- [ ] **Step 3: Implement**

Add a seen-counter at the top of the parse function and a tiny helper:

```typescript
const seenKeys = new Map<string, number>();
const uniqueKey = (base: string): string => {
  const n = (seenKeys.get(base) ?? 0) + 1;
  seenKeys.set(base, n);
  return n === 1 ? base : `${base}:#${n}`;
};
```

Then wrap every `sourceKey:` assignment in the Trades (both option + stock branches) and Transfers blocks: `sourceKey: uniqueKey(\`ibkr:trade:...\`)`.

- [ ] **Step 4: Run tests, then full suite**

Run: `npx vitest run tests/import/ && npx vitest run`
Expected: green.

---

### Task 4: ACATS original-lot repair script

**Files:**
- Create: `scripts/repair-acats-opening-lots.ts`
- Test: `tests/scripts/repair-acats-opening-lots.test.ts` (create — export the core function from the script and test it on `:memory:`; follow the pattern of an existing tested script, e.g. `grep -rl "repair" tests/` for a precedent)

**Interfaces:**
- Consumes: post-rebuild DB state where the Jan-2024 import created 4 auto rows keyed `ibkr:xfer:2024-01-05:{SQQQ|TQQQ|TTD|UCO}:{qty}:In`.
- Produces: those 4 rows replaced by 9 per-lot `TRANSFER_IN` rows keyed `ibkr:xferlot:{acqDate}:{symbol}:{qty}`, dated at the ORIGINAL acquisition dates (worksheet), priced at basis/qty. Exported `repairAcatsOpeningLots(db: Database.Database, opts: { apply: boolean }): { deleted: number; inserted: number; skipped: string[] }`.

- [ ] **Step 1: Write the failing test**

```typescript
it("replaces the 4 auto ACATS rows with 9 worksheet lots (idempotent)", () => {
  // seed: IBKR account + 4 securities + the 4 auto TRANSFER_IN rows
  seedAutoAcatsRows(db); // helper in test: inserts the 4 ibkr:xfer:2024-01-05:* rows
  const r1 = repairAcatsOpeningLots(db, { apply: true });
  expect(r1.deleted).toBe(4);
  expect(r1.inserted).toBe(9);
  const lots = db.prepare(
    "SELECT trade_date, quantity, amount FROM transactions WHERE type='TRANSFER_IN' ORDER BY trade_date, quantity"
  ).all() as any[];
  expect(lots).toHaveLength(9);
  // spot-check one: SQQQ 500 @ 2023-12-22, basis 8873.79
  expect(lots.some((l) => l.trade_date === "2023-12-22" && l.quantity === 500)).toBe(true);
  // idempotent: second run is a no-op
  const r2 = repairAcatsOpeningLots(db, { apply: true });
  expect(r2.deleted).toBe(0);
  expect(r2.inserted).toBe(0);
});
```

- [ ] **Step 2: Run to verify it fails** (module not found), then **Step 3: Implement**

The curated table (from the 8949 worksheet — copy EXACTLY):

```typescript
const ACATS_LOTS = [
  { symbol: "SQQQ", qty: 100,  acqDate: "2023-11-27", basis: 1647.21 },
  { symbol: "SQQQ", qty: 100,  acqDate: "2023-12-05", basis: 1674.95 },
  { symbol: "SQQQ", qty: 500,  acqDate: "2023-12-22", basis: 8873.79 },
  // Worksheet lists this lot's acquisition as "VARIOUS" — dated at the
  // ACATS transfer date; basis is exact. Sold 2024-01-09, so holding-period
  // display is approximate but ST/LT classification is unaffected.
  { symbol: "SQQQ", qty: 1800, acqDate: "2024-01-05", basis: 30038.20 },
  { symbol: "TQQQ", qty: 150,  acqDate: "2023-12-13", basis: 7352.50 },
  { symbol: "TTD",  qty: 50,   acqDate: "2023-12-18", basis: 3762.50 },
  { symbol: "TTD",  qty: 100,  acqDate: "2023-12-18", basis: 7525.00 },
  { symbol: "UCO",  qty: 200,  acqDate: "2023-12-05", basis: 6663.00 },
  { symbol: "UCO",  qty: 150,  acqDate: "2023-12-05", basis: 4997.25 },
] as const;
```

Core logic: for each of the 4 symbols, find the auto row by `source_key LIKE 'ibkr:xfer:2024-01-05:' || symbol || ':%:In'` in the IBKR account; if present (or if curated rows are missing), inside ONE `db.transaction()`: DELETE the auto row, INSERT the curated rows with `source_key = 'ibkr:xferlot:' + acqDate + ':' + symbol + ':' + qty` (INSERT OR IGNORE gives idempotence), `type='TRANSFER_IN'`, `quantity=qty`, `amount=basis`, `price_per_share=basis/qty`, `notes='ACATS from Robinhood 2024-01-05; basis per IBKR Form 8949 worksheet 2024'`. Resolve `account_id` by name `IBKR` and `security_id` via symbol lookup — abort with a clear message if a security is missing (they will exist post-rebuild). Dry-run default prints the plan; `--apply` executes; after apply, call `computeTaxLots(db)` + `computeDailyValuations(db)`. CLI wrapper at the bottom guarded by `if (require.main === module)` or the repo's tsx-script idiom (copy from `scripts/repair-canonical-option-prices.ts`).

- [ ] **Step 4: Run tests + full suite**

Run: `npx vitest run tests/scripts/repair-acats-opening-lots.test.ts && npx vitest run`
Expected: green.

---

### Task 5: Rebuild driver script

**Files:**
- Create: `scripts/rebuild-ibkr-ledger.ts`
- Test: `tests/scripts/rebuild-ibkr-ledger.test.ts` (test the exported preflight + orchestration pieces on `:memory:`/fixture strings; the file-path manifest itself is exercised live)

**Interfaces:**
- Consumes: `parseImport` + `commitImport` + `undoImport` (`lib/import/engine.ts`), `repairAcatsOpeningLots` (Task 4), `computeTaxLots`, `computeDailyValuations`.
- Produces: CLI `npx tsx scripts/rebuild-ibkr-ledger.ts [--apply]`.

- [ ] **Step 1: Write the preflight + its test first**

Exported `preflightStatementFile(content: string): { period: string | null; tradeRows: number; ok: boolean }` — ok requires a `Statement,Data,Period` line AND ≥1 `Trades,Data,Order` row. Test with a good fixture and a sectionless fixture (MTM-style) that must fail (the `IBKR MTM 2024/` folder files are the trap this guards against).

- [ ] **Step 2: Implement the driver sequence**

```typescript
const FILES = [
  "/Users/Yitzi/Desktop/Trading - Local/IBKR 2024 activity.csv",
  "/Users/Yitzi/Desktop/Trading - Local/2025 Annual IBKR.csv",
  "/Users/Yitzi/Desktop/Trading - Local/Trading/IBKR 2026-01 activity.csv",
  "/Users/Yitzi/Desktop/Trading - Local/Trading/2026-02 IBKR Activity Statement.csv",
  "/Users/Yitzi/Desktop/Trading - Local/Trading/IBKR march 26.csv",
  "/Users/Yitzi/Desktop/Trading - Local/july 2026 IBKR statement.csv",
];
const CANONICAL_BATCH_ID = 17;
```

Sequence (dry-run prints each step's plan; `--apply` executes):
1. Preflight ALL files (read + `preflightStatementFile`); abort listing failures. Print each file's period so overlaps are visible.
2. Backup: `VACUUM INTO 'data/backups/pre-ibkr-rebuild-<todayET>.db'` (create `data/backups/` if absent; abort if backup fails — NEVER proceed unbacked).
3. Sanity-print batch 17: transaction count + date span (`SELECT COUNT(*), MIN(trade_date), MAX(trade_date) FROM transactions WHERE import_batch_id = 17`). Abort if count ≠ 2,493 (DB changed since the audit — re-verify manually).
4. `undoImport(db, 17)` — but note undoImport recomputes tax lots + valuations internally; that intermediate recompute on a half-rebuilt ledger is wasted work but harmless. To avoid double recompute, call `deleteImportBatch(db, 17)` directly (import it from wherever engine.ts does) and defer recompute to step 7.
5. For each file: `await parseImport(...)` → `commitImport(db, parsed)`. Print per-file: transactions inserted, transactions deduped (source_key collisions with EXISTING Apr–Jun batches are expected ZERO except genuine overlaps — print the number), validation warnings verbatim (watch for "Forecast Contracts by ForecastEx" asset-category rows and Forex rows — record what validation does with them; do not silently swallow).
6. `repairAcatsOpeningLots(db, { apply: true })`.
7. `computeTaxLots(db)` + `computeDailyValuations(db)`.
8. Print the closing census: total IBKR transactions by type, negative-hpd row count (expect: far below 626), and `SELECT COUNT(*) FROM transactions WHERE type='RECONCILE_CLOSE'`.

- [ ] **Step 3: Run script tests + full suite**

Run: `npx vitest run tests/scripts/ && npx vitest run`
Expected: green. Do NOT run the driver against the live DB in this task — that is Task 7, with the user.

---

### Task 6: Acceptance verification script

**Files:**
- Create: `scripts/audit-ibkr-ledger-vs-broker.ts`
- Test: `tests/scripts/audit-ibkr-ledger-vs-broker.test.ts` (pure-function tests for the gap computation on a seeded `:memory:` DB)

**Interfaces:**
- Consumes: `transactions`, `holdings` (broker rows: `source_key LIKE 'tws-%' OR 'ibkr:%'` — EXCLUDE `recon:%` tombstones and `plaid:%`), `tax_lot_sales`.
- Produces: exported `auditLedgerVsBroker(db): { pairs: number; clean: number; gapped: Array<{symbol: string; date: string; broker: number; ledger: number; gap: number}> }` + CLI report.

- [ ] **Step 1: Write the failing test**

Seed one clean pair (buys sum to the broker row) and one gapped pair (broker 100, ledger 40) and assert the report splits them. Include a same-day-trade case: a broker row dated the same day as a trade must count as clean if EITHER including or excluding that day's trades matches (TWS intraday rows are captured mid-day; the ledger can't know if the row preceded the fill — the audit's AAL false-positive, 2026-08-03).

```typescript
it("tolerates same-day trade ambiguity", () => {
  // broker row 2026-04-22 qty -1000; trades: SELL 1000 on 04-21, BUY 1000 on 04-22
  // include-04-22 → 0, exclude-04-22 → -1000: matches broker → clean
  const r = auditLedgerVsBroker(db);
  expect(r.gapped).toHaveLength(0);
});
```

- [ ] **Step 2: Implement**

Position math mirrors the engine's type semantics exactly (buys: `buy, reinvestment, buy_to_open, sell_to_open, transfer_in`; sells: `sell, sell_to_close, redemption, buy_to_cover, expired, exercised, assigned, buy_to_close`; ignore `RECONCILE_CLOSE` — engine-owned synthetic). For every IBKR (security) pair with ≥1 broker holdings row, evaluate the LATEST broker row plus the row nearest 2026-06-30 (full-statement-coverage date): clean iff min(|gap_incl|, |gap_excl|) < 1e-6. CLI prints the gapped table sorted by |gap| desc and exits 1 if any gapped (so it can gate).

- [ ] **Step 3: Run tests + full suite**

Expected: green.

---

### Task 7: Live rebuild + acceptance (interactive, with the user)

**Files:** none created — this is the runbook. Execute in the main session, not a subagent.

- [ ] **Step 1: Dry-run** — `npx tsx scripts/rebuild-ibkr-ledger.ts`; read every preflight period + plan line aloud to the user (six files: 2024 annual, 2025 annual, Jan/Feb/Mar 2026, Jul 2026).
- [ ] **Step 2: Apply** — `npx tsx scripts/rebuild-ibkr-ledger.ts --apply` (user pre-authorized 2026-08-03; backup path printed first).
- [ ] **Step 3: Acceptance gates, in order:**
  1. `npx tsx scripts/audit-ibkr-ledger-vs-broker.ts` → expect exit 0 / zero gapped pairs. Any residual gap: investigate that symbol's statement rows before proceeding (July-lag names should now be covered through 7/31; August trades since the last statement are the only tolerated gap — the audit's same-day rule plus an explicit `--as-of 2026-07-31` flag may be needed; if so, add it).
  2. Negative-hpd census: `SELECT COUNT(*) FROM tax_lot_sales WHERE holding_period_days < 0` — expect a small number, and EVERY remaining row must trace to a broker-confirmed short (spot-check 5 against holdings).
  3. `npx tsx scripts/audit-twr-vs-statements.ts` → must exit 0 (the >20% tolerance gate).
  4. `npx vitest run` → green.
  5. Browser spot-check (agent-browser): Analysis → Trade Reviews → IBKR March 2026 → QCOM lot breakdown (the original QA repro) — no future-dated lots unless QCOM was genuinely short; Security Detail SQQQ → tax lots show the 2023 ACATS lots.
- [ ] **Step 4: Bookkeeping** — update `qa/findings/ledger.json` FIFO finding (`status: fixed`, fix note referencing this plan), TODO.md (close the audit item's remediation decision as executed; note the VGT split-repair interaction: position-risk recomputes may shift), CLAUDE.md conventions (one line: IBKR ledger is native-statement-sourced 2024→present; TRANSFER_IN is lot-creating; canonical batch 17 retired 2026-08-03 — backup at `data/backups/`).
- [ ] **Step 5: Session-end** — commits batched per the user's directive: parser+engine+scripts commits, then the bookkeeping commit. Electron rebuild via the session-end checklist.

**Rollback:** restore `data/backups/pre-ibkr-rebuild-<date>.db` over `data/vanguard.db` with the app closed, then `computeTaxLots` + `computeDailyValuations`.

---

## Self-review notes

- Spec coverage: parser Transfers ✓ (T1), engine lots ✓ (T2), dup hardening ✓ (T3), worksheet lots ✓ (T4), retire+reimport ✓ (T5), acceptance ✓ (T6/T7). Option expiries need NO new code — verified present in Trades section as `C;Ep` zero-price closes, which the existing parser already imports and the engine already closes at $0.
- Type consistency: `repairAcatsOpeningLots(db, {apply})` (T4) is what T5 step 6 calls; `preflightStatementFile` (T5) is self-contained; `auditLedgerVsBroker` (T6) standalone.
- Known accepted imperfections: SQQQ's 1,800-share "VARIOUS" lot dated at transfer date (basis exact, ST/LT unaffected); August-to-date trades absent until the August statement (tolerated gap in acceptance); Vanguard TRANSFER_IN rows now create small legitimate lots (test fixtures may need updating, flagged in T2).
