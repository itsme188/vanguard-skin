# Number-Trust Containment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Revision 2 (2026-08-23):** incorporates the Codex design-review round (verdict REVISE → findings addressed or explicitly declined; the decision record lives in the session log). Sanitized: this repo is PUBLIC — all live DB ids, dollar amounts, and source keys live in the gitignored config `data/repair-configs/security-type-corruption.json`, never in committed code, tests, or this plan. Test fixtures below use synthetic values by design.

**Goal:** Contain the four user-decided P0 findings from the 2026-08-21 Codex number-trust audit — repair the corrupted security identities (with an import guard on the inlet), banner the tax exports as not-for-filing, relabel the circular TWR/Data-Confidence assurances honestly, and stop live-snapshot timing residuals from being flagged as unexplained external cash flows.

**Architecture:** Four independent containment lanes. Lane A (Tasks 1–4): an import-time guard in `upsertSecurity` plus a config-driven, dry-run-default repair script (`repair-etf-types.ts` family) that fixes the known mistyped securities, re-homes the mis-transcribed Treasury coupon rows, and sweeps for unknown siblings — apply is all-or-nothing. Lane B (Task 5): a warning banner + NOT-FOR-FILING filenames on the tax exports. Lane C (Tasks 6–7): copy/tone-only relabels of the TWR reconciliation surfaces and the Data Confidence badge. Lane D (Tasks 8–9): a new `live-anchor-residual` classification in the cash-flow audit engine (shared by Data Confidence AND the flow-repair script, so neither can ever propose synthesizing a deposit for a Plaid timing plug), wired into the confidence warning as a visible-but-non-capping label.

**Tech Stack:** TypeScript 5, better-sqlite3 (DI — every db fn takes `db`), Vitest with in-memory SQLite, Next.js 16 server/client components.

**Spec:** `docs/private/codex-number-trust-audit-2026-08-21.md` (LOCAL-ONLY, gitignored — findings + evidence with real figures). User decisions (2026-08-23 session): (1) audit-sweep repair + import guard; (2) tax exports bannered "not for filing" now, the ÷100/short-column engine fix is a separately spec'd future task; (3) relabel TWR check + Data Confidence badge now, independent reconciliation designed later; (4) label live-snapshot cash residuals and suppress the unexplained-flow score cap for them (visible label stays).

## Global Constraints

- **Privacy (public repo):** no real DB ids, transaction ids, dollar amounts, share counts, source keys, CUSIPs, or holdings facts in any committed file — code, tests, comments, commit messages, or this plan. Live constants come from `data/repair-configs/security-type-corruption.json` (gitignored). Synthetic fixtures only in tests.
- Run all tests/scripts with the node pin: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run <path>` / `npx tsx scripts/<name>.ts`.
- All tests use in-memory SQLite (`new Database(":memory:")` + `runMigrations(db)`); never touch `data/vanguard.db` in tests.
- Repair scripts: dry-run by default, write only with `--apply` (`args.includes("--apply")`); **dry-run opens the DB `{ readonly: true }` and sets no pragmas**; apply-mode opens read-write, sets `journal_mode = WAL` + `foreign_keys = ON`, and backs up via `ensureBackup` from `scripts/rebuild-ibkr-ledger.ts` before any write; `isMain` guard so tests can import; trailing `Dry-run (default). Re-run with --apply to write.`
- **Apply is all-or-nothing:** preflight every configured row first; any row in an UNEXPECTED state aborts the entire apply (no partial repair). A row already in its TARGET state is `skipped_already_correct` (no-op success — second apply is a clean no-op).
- NEVER rewrite a `source_key` except the configured coupon rows (their current keys derive from the wrong symbol and a NULL amount; the corrected keys match what `lib/import/parsers/canonical-csv.ts:199` derives from a corrected CSV line, so a corrected re-import dedupes).
- The live-DB `--apply` run is a USER-APPROVED step at the end — no task in this plan mutates the live database.
- UI copy: static English strings, no portfolio numbers.
- After the final task: `npm run verify:changed`, full `npx vitest run` (green; ≥6,235 + new), `npx next build`, and `npm run verify:smoke` (UI-visible changes).

## Repair config schema (`data/repair-configs/security-type-corruption.json`, gitignored)

The real file already exists locally (written 2026-08-23, constants verified against the live DB and the source CSVs). Schema, with SYNTHETIC illustrative values:

```jsonc
{
  "knownTypeRepairs": [
    {
      "id": 900,                     // securities.id
      "symbol": "AAA",
      "expectType": "Bond",          // current wrong type (case-insensitive precondition)
      "setType": "Stock",
      "setName": "EXAMPLE CORP",     // optional — only when the name is also corrupted
      "expectNameLike": "TREASURY",  // optional substring precondition, required when setName present
      "clearBondFields": true        // optional — NULL maturity_date, duration_years, credit_rating, coupon_rate
    }
  ],
  "treasuryInterestRehomes": [
    {
      "transactionId": 5001,
      "fromSecurityId": 900,
      "toSecurityId": 901,
      "expectTradeDate": "2025-01-15",  // precondition; row must also be type INTEREST, amount NULL
      "expectFees": 123.45,             // precondition (the coupon landed in the fees column)
      "setAmount": 123.45,              // corrected amount; fees set to 0
      "newSourceKey": "canonical:txn:Acct:CUSIP:2025-01-15:INTEREST:12345"
    }
  ],
  "neverUndoImportBatches": [1, 2],   // batches whose undo would delete repaired rows — script prints a warning
  "csvCorrections": [                  // printed for the user; the script never edits files outside the repo
    { "file": "~/path/file.csv", "approxLine": 1, "fix": "human-readable instruction" }
  ]
}
```

Background for implementers (mechanism, no live specifics): a Vanguard-statement transcription split a Treasury line across columns — the leading letter of the security NAME landed in the symbol column, colliding with a real held equity ticker; `upsertSecurity`'s name-COALESCE and one-directional type guard then stamped bond identity onto the equity row, sending a live position through the bond ÷100 valuation path. The coupon amount also drifted into the fees column (amount NULL). The correct CUSIP-keyed bond security already exists in the DB; the rehome repoints the coupon rows to it. Sibling class: statement-PDF section mis-bucketing typed two held common stocks as ETF and one LP as Mutual Fund (`lib/import/parsers/vanguard-pdf.ts:277-286` derives type purely from the extracted section category).

---

### Task 1: Import guard — bond-like metadata must never land on an equity-fill security

**Files:**
- Modify: `lib/mutations/securities.ts` (guard block between the `existing` lookup at :116-118 and the INSERT at :145)
- Test: `tests/mutations/securities.test.ts` (extend), `tests/mutations/upsert-security-bond-maturity.test.ts` (one companion case)

**Interfaces:**
- Consumes: existing `upsertSecurity(db, params)` (`UpsertSecurityParams`, lib/mutations/securities.ts:5-17).
- Produces: no new exports. Behavior contract: an incoming `securityType` of `Bond`/`Mutual Fund` onto an existing `Stock`/`ETF` security **that has equity fills** proceeds with the upsert but with `securityType`, `name`, and `maturityDate` stripped from the incoming params (a `console.warn` names the refusal). Everything else (currency, multiplier, etc.) still applies.

Design notes (Codex-reviewed):
- "Strip fields and continue" rather than the option-guard's "return early": the transaction row itself must still import (it's a real coupon, just mis-keyed) — only the identity-corrupting metadata is refused. Surfacing guard refusals in the import PREVIEW UI is a filed follow-up, not this task.
- Asymmetry is deliberate: real bonds are CUSIP-symboled; a ticker symbol with actual equity fills being retyped to Bond is effectively always the transcription bug. A genuine statement-directed correction still has a path: the warn is loud, and a manual retype/repair remains possible.
- The bond-maturity auto-derive at :67-77 runs BEFORE the `existing` lookup, so the guard must strip `maturityDate` too (it may already be populated from the bad name).

Equity-fill probe (one prepared statement, run only when the cheap type-conflict test already matched — not on the hot path for normal upserts):

```sql
SELECT COUNT(*) AS n FROM transactions
 WHERE security_id = ?
   AND UPPER(type) IN ('BUY','SELL','SHORT_SELL','BUY_TO_COVER',
                       'BUY_TO_OPEN','SELL_TO_OPEN','BUY_TO_CLOSE','SELL_TO_CLOSE')
   AND quantity IS NOT NULL AND quantity <> 0
```

- [ ] **Step 1: Write the failing tests**

In `tests/mutations/securities.test.ts`, new describe block after the existing `weak 'Stock' never downgrades a fund-family type` block (:264-299). Copy the file's existing fixture setup (db creation, accounts insert helper if present); synthetic values only:

```ts
describe("bond-like metadata never lands on an equity-fill security", () => {
  function insertEquityFill(db: Database.Database, securityId: number) {
    db.prepare(`INSERT INTO accounts (name, account_type) VALUES ('T', 'taxable')`).run();
    db.prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, amount)
       VALUES (1, ?, '2026-01-05', 'BUY', 100, -1000)`
    ).run(securityId);
  }

  it("refuses Bond type + bond-like name + maturity onto a Stock with equity fills", () => {
    const id = upsertSecurity(db, { symbol: "AAA", name: "EXAMPLE CORP", securityType: "Stock" });
    insertEquityFill(db, id);
    const again = upsertSecurity(db, {
      symbol: "AAA",
      name: "S TREASURY NOTE 0 CPN 9.999% DUE 01/15/40 DTD 01/15/25",
      securityType: "Bond",
    });
    expect(again).toBe(id);
    const row = db
      .prepare(`SELECT name, security_type, maturity_date FROM securities WHERE id = ?`)
      .get(id) as { name: string; security_type: string; maturity_date: string | null };
    expect(row.security_type).toBe("Stock");
    expect(row.name).toBe("EXAMPLE CORP");
    expect(row.maturity_date).toBeNull();
  });

  it("still allows Bond onto a Stock-typed row with NO equity fills (legit CUSIP retype)", () => {
    const id = upsertSecurity(db, { symbol: "999999ZZ9", securityType: "Stock" });
    upsertSecurity(db, { symbol: "999999ZZ9", name: "U S TREASURY BILL DUE 12/15/26", securityType: "Bond" });
    const row = db.prepare(`SELECT security_type FROM securities WHERE id = ?`).get(id) as {
      security_type: string;
    };
    expect(row.security_type).toBe("Bond");
  });

  it("refuses Mutual Fund onto a Stock with equity fills (LP-mistype inlet class)", () => {
    const id = upsertSecurity(db, { symbol: "BBB", name: "EXAMPLE PARTNERS LP", securityType: "Stock" });
    insertEquityFill(db, id);
    upsertSecurity(db, { symbol: "BBB", securityType: "Mutual Fund" });
    const row = db.prepare(`SELECT security_type FROM securities WHERE id = ?`).get(id) as {
      security_type: string;
    };
    expect(row.security_type).toBe("Stock");
  });

  it("other incoming fields still apply when the bond metadata is stripped", () => {
    const id = upsertSecurity(db, { symbol: "AAA", name: "EXAMPLE CORP", securityType: "Stock" });
    insertEquityFill(db, id);
    upsertSecurity(db, {
      symbol: "AAA", securityType: "Bond", name: "S TREASURY NOTE …", currency: "USD", multiplier: 1,
    });
    const row = db.prepare(`SELECT security_type, name FROM securities WHERE id = ?`).get(id) as {
      security_type: string; name: string;
    };
    expect(row.security_type).toBe("Stock");
    expect(row.name).toBe("EXAMPLE CORP");
  });
});
```

In `tests/mutations/upsert-security-bond-maturity.test.ts`, one companion case in the existing describe:

```ts
it("does not auto-derive maturity onto an equity-fill security when the Bond type is refused", () => {
  const id = upsertSecurity(db, { symbol: "AAA", name: "EXAMPLE CORP", securityType: "Stock" });
  db.prepare(`INSERT INTO accounts (name, account_type) VALUES ('T','taxable')`).run();
  db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, amount)
     VALUES (1, ?, '2026-01-05', 'SELL', 50, 900)`
  ).run(id);
  upsertSecurity(db, {
    symbol: "AAA",
    name: "S TREASURY NOTE 0 CPN 9.999% DUE 01/15/40",
    securityType: "Bond",
  });
  const row = db.prepare(`SELECT maturity_date FROM securities WHERE id = ?`).get(id) as {
    maturity_date: string | null;
  };
  expect(row.maturity_date).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/mutations/securities.test.ts tests/mutations/upsert-security-bond-maturity.test.ts`
Expected: the 5 new tests FAIL (Bond currently overwrites Stock via the `ELSE COALESCE` branch); all pre-existing tests PASS.

- [ ] **Step 3: Implement the guard**

In `lib/mutations/securities.ts`, after the option-conflict guard block (after :135):

```ts
// Bond-like identity must never land on a security whose ledger shows equity
// fills (2026-08-21 audit: a statement transcription put a name-fragment in
// the symbol column, colliding with a held equity ticker; the incoming Bond
// type + Treasury name + derived maturity stamped bond identity onto the
// equity row, sending a live position through the bond ÷100 valuation path).
// The CASE guard below only blocks weak incoming 'Stock'; this is the
// symmetric strong-evidence direction. The transaction row itself still
// imports — only the identity-corrupting metadata is refused. Real bonds are
// CUSIP-symboled: a ticker with actual equity fills retyped to Bond is
// effectively always a transcription defect, and a genuine correction still
// has the manual-repair path (the warn below is the audit trail).
if (existing && p.securityType) {
  const incoming = p.securityType.toLowerCase();
  const existingType = (existing.security_type ?? "").toLowerCase();
  if (
    (incoming === "bond" || incoming === "mutual fund") &&
    (existingType === "stock" || existingType === "etf")
  ) {
    const fills = db
      .prepare(
        `SELECT COUNT(*) AS n FROM transactions
          WHERE security_id = ?
            AND UPPER(type) IN ('BUY','SELL','SHORT_SELL','BUY_TO_COVER',
                                'BUY_TO_OPEN','SELL_TO_OPEN','BUY_TO_CLOSE','SELL_TO_CLOSE')
            AND quantity IS NOT NULL AND quantity <> 0`
      )
      .get(existing.id) as { n: number };
    if (fills.n > 0) {
      console.warn(
        `[upsertSecurity] Refusing ${p.securityType} identity for "${p.symbol}": ` +
          `existing ${existing.security_type} security has ${fills.n} equity fills. ` +
          `Dropping incoming security_type/name/maturity_date; check the source row's symbol.`
      );
      p = { ...p, securityType: undefined, name: undefined, maturityDate: undefined };
    }
  }
}
```

(Match the file's actual local variable names — the normalized params object may differ; the strip must hit whatever feeds the INSERT bindings, including the already-derived maturity.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/mutations/securities.test.ts tests/mutations/upsert-security-bond-maturity.test.ts`
Expected: ALL PASS (new + pre-existing — especially the `weak 'Stock'` block and the option-conflict guards).

- [ ] **Step 5: Commit**

```bash
git add lib/mutations/securities.ts tests/mutations/securities.test.ts tests/mutations/upsert-security-bond-maturity.test.ts
git commit -F /tmp/msg-t1.txt   # "fix(import): refuse bond-like identity onto equity-fill securities (audit P0 inlet)"
```

---

### Task 2: Repair script core — config loading + known-corruption retype

**Files:**
- Create: `scripts/repair-security-type-corruption.ts`
- Test: `tests/scripts/repair-security-type-corruption.test.ts`

**Interfaces:**
- Consumes: `runMigrations` (tests); the gitignored config (CLI only — tests construct configs inline with synthetic values).
- Produces (exported, used by Tasks 3–4 and tests):

```ts
export interface KnownTypeRepair {
  id: number;
  symbol: string;
  expectType: string;
  setType: string;
  setName?: string;
  expectNameLike?: string;   // required when setName is present
  clearBondFields?: boolean;
}
export interface RepairConfig {
  knownTypeRepairs: KnownTypeRepair[];
  treasuryInterestRehomes: InterestRehome[];   // Task 3
  neverUndoImportBatches: number[];
  csvCorrections: { file: string; approxLine: number; fix: string }[];
}
export function loadRepairConfig(path: string): RepairConfig;  // JSON.parse + shape validation, throws on missing/invalid

export type TypeRepairAction =
  | "repaired" | "would_repair" | "skipped_already_correct" | "precondition_mismatch";
export interface TypeRepairOutcome {
  symbol: string;
  action: TypeRepairAction;
  previousType: string | null;
  detail?: string;
}
// PURE PREFLIGHT + APPLY SPLIT (all-or-nothing contract):
export function preflightTypeRepairs(db: Database.Database, repairs: KnownTypeRepair[]): TypeRepairOutcome[];
// applyTypeRepairs REQUIRES a clean preflight (no precondition_mismatch) — it re-runs
// the preflight internally and THROWS before writing anything if any row mismatches.
// Rows at skipped_already_correct are no-ops. Runs inside the CALLER's transaction
// (Task 4 wraps type repairs + rehomes in ONE outer db.transaction).
export function applyTypeRepairs(db: Database.Database, repairs: KnownTypeRepair[]): TypeRepairOutcome[];
```

Preflight semantics per row — load `SELECT id, symbol, name, security_type FROM securities WHERE id = ?`:
- Row missing, symbol mismatch (case-insensitive), or `security_type` matching NEITHER `expectType` NOR `setType`, or (`expectNameLike` set AND name matches neither the expected substring nor the target `setName`) → `precondition_mismatch` with `detail` naming what differed.
- `security_type` already equals `setType` (case-insensitive) AND (no `setName` or name already equals `setName`) → `skipped_already_correct`.
- Otherwise → `would_repair`.

Apply UPDATE (per eligible row, inside the caller's transaction):

```sql
UPDATE securities
   SET security_type = @setType,
       name = COALESCE(@setName, name),
       maturity_date  = CASE WHEN @clearBondFields THEN NULL ELSE maturity_date END,
       duration_years = CASE WHEN @clearBondFields THEN NULL ELSE duration_years END,
       credit_rating  = CASE WHEN @clearBondFields THEN NULL ELSE credit_rating END,
       coupon_rate    = CASE WHEN @clearBondFields THEN NULL ELSE coupon_rate END
 WHERE id = @id
```

- [ ] **Step 1: Write the failing tests**

`tests/scripts/repair-security-type-corruption.test.ts` (modeled on `tests/scripts/repair-etf-types.test.ts`; ALL values synthetic):

```ts
import Database from "better-sqlite3";
import { describe, it, expect, beforeEach } from "vitest";
import { runMigrations } from "@/lib/db/migrate";
import {
  preflightTypeRepairs,
  applyTypeRepairs,
  type KnownTypeRepair,
} from "@/scripts/repair-security-type-corruption";

function createTestDb() {
  const db = new Database(":memory:");
  runMigrations(db);
  return db;
}

const FAKE_TREASURY_NAME = "S TREASURY NOTE 0 CPN 9.999% DUE 01/15/40 DTD 01/15/25";

const REPAIR: KnownTypeRepair = {
  id: 900, symbol: "AAA", expectType: "Bond", setType: "Stock",
  setName: "EXAMPLE CORP", expectNameLike: "TREASURY", clearBondFields: true,
};

function seedCorrupted(db: Database.Database) {
  db.prepare(
    `INSERT INTO securities (id, symbol, name, security_type, asset_class, maturity_date, coupon_rate)
     VALUES (900, 'AAA', ?, 'Bond', 'equity', '2040-01-15', 9.999)`
  ).run(FAKE_TREASURY_NAME);
}

describe("preflightTypeRepairs / applyTypeRepairs", () => {
  let db: Database.Database;
  beforeEach(() => { db = createTestDb(); });

  it("preflight reports would_repair and writes nothing", () => {
    seedCorrupted(db);
    const out = preflightTypeRepairs(db, [REPAIR]);
    expect(out).toEqual([{ symbol: "AAA", action: "would_repair", previousType: "Bond" }]);
    const row = db.prepare(`SELECT security_type, maturity_date FROM securities WHERE id = 900`).get() as any;
    expect(row.security_type).toBe("Bond");
    expect(row.maturity_date).toBe("2040-01-15");
  });

  it("apply retypes, restores the name, and clears bond fields", () => {
    seedCorrupted(db);
    applyTypeRepairs(db, [REPAIR]);
    const row = db
      .prepare(`SELECT security_type, name, maturity_date, coupon_rate FROM securities WHERE id = 900`)
      .get() as any;
    expect(row.security_type).toBe("Stock");
    expect(row.name).toBe("EXAMPLE CORP");
    expect(row.maturity_date).toBeNull();
    expect(row.coupon_rate).toBeNull();
  });

  it("a row already in its target state is skipped_already_correct and apply is a clean no-op", () => {
    db.prepare(
      `INSERT INTO securities (id, symbol, name, security_type) VALUES (900, 'AAA', 'EXAMPLE CORP', 'Stock')`
    ).run();
    expect(preflightTypeRepairs(db, [REPAIR])[0].action).toBe("skipped_already_correct");
    const out = applyTypeRepairs(db, [REPAIR]);       // second-apply idempotence
    expect(out[0].action).toBe("skipped_already_correct");
  });

  it("an unexpected state fails preflight and applyTypeRepairs throws before writing ANYTHING", () => {
    db.prepare(
      `INSERT INTO securities (id, symbol, name, security_type) VALUES (900, 'AAA', 'SOMETHING ELSE', 'ETF')`
    ).run();
    db.prepare(
      `INSERT INTO securities (id, symbol, name, security_type) VALUES (901, 'CCC', ?, 'Bond')`
    ).run(FAKE_TREASURY_NAME);
    const second: KnownTypeRepair = {
      id: 901, symbol: "CCC", expectType: "Bond", setType: "Stock",
      setName: "OTHER CORP", expectNameLike: "TREASURY",
    };
    expect(preflightTypeRepairs(db, [REPAIR, second])[0].action).toBe("precondition_mismatch");
    expect(() => applyTypeRepairs(db, [REPAIR, second])).toThrow(/precondition/i);
    // the OTHER (clean) row must be untouched — all-or-nothing
    const row = db.prepare(`SELECT security_type FROM securities WHERE id = 901`).get() as any;
    expect(row.security_type).toBe("Bond");
  });

  it("a repair without setName leaves the existing name untouched", () => {
    db.prepare(
      `INSERT INTO securities (id, symbol, name, security_type) VALUES (902, 'DDD', 'REAL STOCK INC.', 'ETF')`
    ).run();
    applyTypeRepairs(db, [{ id: 902, symbol: "DDD", expectType: "ETF", setType: "Stock" }]);
    const row = db.prepare(`SELECT security_type, name FROM securities WHERE id = 902`).get() as any;
    expect(row.security_type).toBe("Stock");
    expect(row.name).toBe("REAL STOCK INC.");
  });

  it("a missing row id is precondition_mismatch, not a throw, at preflight", () => {
    expect(preflightTypeRepairs(db, [REPAIR])[0].action).toBe("precondition_mismatch");
  });
});
```

Also test `loadRepairConfig` with a temp JSON file (valid shape parses; missing `knownTypeRepairs` throws).

- [ ] **Step 2: Run tests to verify they fail** — `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/scripts/repair-security-type-corruption.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement** the header doc (mechanism description only — no live specifics; refusal + all-or-nothing contract; pointer to Task 1's guard), `loadRepairConfig`, `preflightTypeRepairs`, `applyTypeRepairs` per the interface block.

- [ ] **Step 4: Run tests to verify they pass** (same command).

- [ ] **Step 5: Commit**

```bash
git add scripts/repair-security-type-corruption.ts tests/scripts/repair-security-type-corruption.test.ts
git commit -F /tmp/msg-t2.txt   # "feat(repair): config-driven security-type corruption preflight/apply core"
```

---

### Task 3: Repair script — coupon re-home + contradiction detector

**Files:**
- Modify: `scripts/repair-security-type-corruption.ts`
- Test: `tests/scripts/repair-security-type-corruption.test.ts` (extend)

**Interfaces:**
- Consumes: Task 2's `TypeRepairAction`, `RepairConfig`.
- Produces (exported):

```ts
export interface InterestRehome {
  transactionId: number;
  fromSecurityId: number;
  toSecurityId: number;
  expectTradeDate: string;
  expectFees: number;
  setAmount: number;
  newSourceKey: string;
}
export interface RehomeOutcome { transactionId: number; action: TypeRepairAction; detail?: string }
export function preflightRehomes(db: Database.Database, rehomes: InterestRehome[]): RehomeOutcome[];
export function applyRehomes(db: Database.Database, rehomes: InterestRehome[]): RehomeOutcome[]; // same all-or-nothing contract as applyTypeRepairs

export interface ContradictionRow {
  id: number; symbol: string; securityType: string;
  equityFills: number; fundCategory: string | null; reason: string;
}
export function findTypeContradictions(db: Database.Database, excludeIds: number[]): ContradictionRow[];
```

Rehome preflight per row: transaction exists with `security_id = fromSecurityId`, `trade_date = expectTradeDate`, `type = 'INTEREST'`, `amount IS NULL`, `fees = expectFees`; target `toSecurityId` exists with a bond-family type; AND `newSourceKey` does not already exist in `transactions` (a corrected re-import may have landed first) → else `precondition_mismatch`. Already at target (`security_id = toSecurityId` and `source_key = newSourceKey`) → `skipped_already_correct`. Apply UPDATE:

```sql
UPDATE transactions
   SET security_id = @toSecurityId, amount = @setAmount, fees = 0, source_key = @newSourceKey
 WHERE id = @transactionId
```

`findTypeContradictions(db, excludeIds)` — read-only detector, `excludeIds` = the configured known-repair ids. **Predicate 2 covers bond/mutual-fund types ONLY — never 'etf'** (sector ETFs legitimately carry `US Sector Equity%` fund categories; an ETF-typed contradiction needs contract-details `stockType` evidence, which is TWS territory and out of this detector's scope). The fills floor is an empirical review heuristic, clearly labeled — detector hits are `NEEDS REVIEW`, NEVER auto-repaired:

```sql
-- Predicate 1: bond/fund-typed securities whose ledger is dominated by equity fills
-- (floor >10: genuine mutual funds legitimately show some fills; the audit's corrupted
-- row sat far above every real fund).
SELECT s.id, s.symbol, s.security_type,
       SUM(CASE WHEN UPPER(t.type) IN ('BUY','SELL','SHORT_SELL','BUY_TO_COVER')
                 AND t.quantity IS NOT NULL AND t.quantity <> 0 THEN 1 ELSE 0 END) AS equity_fills,
       s.fund_category
  FROM securities s JOIN transactions t ON t.security_id = s.id
 WHERE LOWER(COALESCE(s.security_type,'')) IN ('bond','mutual fund','mutual_fund')
 GROUP BY s.id
HAVING equity_fills > 10;

-- Predicate 2: equity-shaped classification metadata contradicting a bond/fund type.
SELECT id, symbol, security_type, 0 AS equity_fills, fund_category
  FROM securities
 WHERE fund_category LIKE 'US Sector Equity%'
   AND LOWER(COALESCE(security_type,'')) IN ('bond','mutual fund','mutual_fund');
```

Dedup by id across predicates; `reason` names which predicate(s) hit.

- [ ] **Step 1: Write the failing tests** (extend; synthetic values):

```ts
describe("preflightRehomes / applyRehomes", () => {
  let db: Database.Database;
  const REHOME: InterestRehome = {
    transactionId: 5001, fromSecurityId: 900, toSecurityId: 901,
    expectTradeDate: "2025-01-15", expectFees: 123.45, setAmount: 123.45,
    newSourceKey: "canonical:txn:Acct:FAKECUSIP1:2025-01-15:INTEREST:12345",
  };
  beforeEach(() => {
    db = createTestDb();
    db.prepare(`INSERT INTO accounts (id, name, account_type) VALUES (1, 'Acct', 'taxable')`).run();
    seedCorrupted(db); // id 900 from Task 2's helper
    db.prepare(
      `INSERT INTO securities (id, symbol, name, security_type, maturity_date)
       VALUES (901, 'FAKECUSIP1', 'U S TREASURY NOTE CPN 9.999% DUE 01/15/40', 'Bond', '2040-01-15')`
    ).run();
    db.prepare(
      `INSERT INTO transactions (id, account_id, security_id, trade_date, type, quantity, amount, fees, source_key)
       VALUES (5001, 1, 900, '2025-01-15', 'INTEREST', NULL, NULL, 123.45,
               'canonical:txn:Acct:AAA:2025-01-15:INTEREST:0')`
    ).run();
  });

  it("preflight reports would_repair and leaves the row untouched", () => {
    expect(preflightRehomes(db, [REHOME])[0].action).toBe("would_repair");
    const row = db.prepare(`SELECT security_id, amount FROM transactions WHERE id = 5001`).get() as any;
    expect(row.security_id).toBe(900);
    expect(row.amount).toBeNull();
  });

  it("apply repoints, moves the coupon to amount, zeroes fees, rewrites source_key", () => {
    applyRehomes(db, [REHOME]);
    const row = db
      .prepare(`SELECT security_id, amount, fees, source_key FROM transactions WHERE id = 5001`)
      .get() as any;
    expect(row.security_id).toBe(901);
    expect(row.amount).toBe(123.45);
    expect(row.fees).toBe(0);
    expect(row.source_key).toBe(REHOME.newSourceKey);
  });

  it("second apply is skipped_already_correct (idempotent)", () => {
    applyRehomes(db, [REHOME]);
    expect(applyRehomes(db, [REHOME])[0].action).toBe("skipped_already_correct");
  });

  it("refuses when amount is already populated (row was hand-fixed)", () => {
    db.prepare(`UPDATE transactions SET amount = 123.45 WHERE id = 5001`).run();
    expect(preflightRehomes(db, [REHOME])[0].action).toBe("precondition_mismatch");
    expect(() => applyRehomes(db, [REHOME])).toThrow(/precondition/i);
  });

  it("refuses when the corrected source_key already exists (corrected CSV already re-imported)", () => {
    db.prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, amount, source_key)
       VALUES (1, 901, '2025-01-15', 'INTEREST', 123.45, ?)`
    ).run(REHOME.newSourceKey);
    const out = preflightRehomes(db, [REHOME]);
    expect(out[0].action).toBe("precondition_mismatch");
    expect(out[0].detail).toContain("source_key");
  });
});

describe("findTypeContradictions", () => {
  it("flags a bond-typed security with many equity fills + equity fund_category; excludes known ids; ignores ETFs and low-fill funds", () => {
    const db = createTestDb();
    db.prepare(`INSERT INTO accounts (id, name, account_type) VALUES (1, 'T', 'taxable')`).run();
    db.prepare(
      `INSERT INTO securities (id, symbol, security_type, fund_category)
       VALUES (910, 'ZZZ', 'Bond', 'US Sector Equity (Technology)')`
    ).run();
    const buy = db.prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, amount)
       VALUES (1, 910, '2026-01-05', 'BUY', 10, -100)`
    );
    for (let i = 0; i < 12; i++) buy.run();
    // genuine fund below the floor — not flagged
    db.prepare(`INSERT INTO securities (id, symbol, security_type) VALUES (911, 'REALFUND', 'Mutual Fund')`).run();
    db.prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, amount)
       VALUES (1, 911, '2026-01-05', 'BUY', 10, -100)`
    ).run();
    // genuine sector ETF — must NOT be flagged by predicate 2
    db.prepare(
      `INSERT INTO securities (id, symbol, security_type, fund_category)
       VALUES (912, 'XLZ', 'ETF', 'US Sector Equity (Energy)')`
    ).run();
    const rows = findTypeContradictions(db, []);
    expect(rows.map((r) => r.symbol)).toEqual(["ZZZ"]);
    // and the exclude list removes known repairs
    expect(findTypeContradictions(db, [910])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify FAIL / Task 2 tests PASS.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify ALL PASS.**
- [ ] **Step 5: Commit**

```bash
git add scripts/repair-security-type-corruption.ts tests/scripts/repair-security-type-corruption.test.ts
git commit -F /tmp/msg-t3.txt   # "feat(repair): coupon re-home + type-contradiction detector (review-only)"
```

---

### Task 4: Repair script — CLI wiring (readonly dry-run, backup, one transaction, recompute)

**Files:**
- Modify: `scripts/repair-security-type-corruption.ts`

**Interfaces:**
- Consumes: `ensureBackup` from `scripts/rebuild-ibkr-ledger.ts:233` (dynamic import, `repair-ah-closes.ts:181` precedent); the tax-lot + daily-valuation recompute entry points `repair-duplicate-option-securities.ts` uses post-repair (import the same functions it calls); Tasks 2–3 exports; `loadRepairConfig("data/repair-configs/security-type-corruption.json")`.
- Produces: runnable CLI — `npx tsx scripts/repair-security-type-corruption.ts [--apply]`.

`main()` sequence:
1. `const apply = process.argv.includes("--apply")`. Open the DB **`{ readonly: !apply }`**; pragmas (`journal_mode = WAL`, `foreign_keys = ON`) ONLY when applying; `finally { db.close() }`.
2. Missing/invalid config file → print the expected path + schema pointer and exit non-zero (the config is local-only by design).
3. Print the evidence table: current row state for every configured id (securities + transactions).
4. `preflightTypeRepairs` + `preflightRehomes` → print per-row outcomes. `findTypeContradictions(db, configuredIds)` → print `NEEDS REVIEW — not auto-repaired; verify against source documents, then add to the config` (or `none found`).
5. Not applying → print the CSV-correction instructions from the config, the `neverUndoImportBatches` warning (`undoing these batches would DELETE the repaired coupon rows — never undo them after this repair`), and the dry-run trailer. Done.
6. Applying: if ANY preflight row is `precondition_mismatch` → print and exit non-zero WITHOUT writing. Else `ensureBackup(db, "data/backups/pre-security-type-repair-<ISO-ts>.db")`, then ONE `db.transaction(() => { applyTypeRepairs(...); applyRehomes(...); })` — both lanes in a single transaction.
7. Post-apply (outside the transaction): recompute tax lots AND daily valuations (both — leaving valuations to the next sync would leave holdings value/residual cash/allocation stale on a retype); print the daily-identity check for the latest valuation date (`cash_balance + holdings_value = total_value`); print the CSV-correction instructions (MANDATORY — see hazard below), the never-undo warning, and: `Re-enrich the repaired equity on the next TWS connect (exchange/sector refresh — the retype makes the STK contract path valid again).`
8. `isMain` guard (copy `repair-etf-types.ts:438-449`).

**Re-import hazard (why the CSV corrections are mandatory):** rewriting a coupon row's `source_key` frees its original key — re-importing the UNCORRECTED source file would re-insert the bad row under the old key (Task 1's guard blocks the metadata corruption, but the duplicate transaction row would return). The corrected file dedupes against the rewritten key. The script prints this explicitly.

- [ ] **Step 1: Implement `main()`** per the sequence.
- [ ] **Step 2: Dry-run against the live DB (readonly connection — safe):** `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx scripts/repair-security-type-corruption.ts` — expect: config loads; evidence table shows the corrupted state; all rows `would_repair`; detector output reviewed.
- [ ] **Step 3: Run the script's tests + verify:changed:** `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/scripts/repair-security-type-corruption.test.ts && npm run verify:changed` → PASS.
- [ ] **Step 4: Commit**

```bash
git add scripts/repair-security-type-corruption.ts
git commit -F /tmp/msg-t4.txt   # "feat(repair): security-type corruption CLI — readonly dry-run, single-txn apply, recompute"
```

---

### Task 5: Tax export "not for filing" banner + filenames

**Files:**
- Modify: `app/dashboard/components/TaxReportCard.tsx`, `app/api/tax-report/route.ts`
- Test: `tests/dashboard/tax-report-filing-warning.test.ts` (new)

**Interfaces:**
- Produces: `export const FILING_WARNING_COPY: string` from `TaxReportCard.tsx` (pure-export pattern the card already uses for `washSalesCaption`).

```ts
export const FILING_WARNING_COPY =
  "Not ready for filing — a 2026-08-21 audit found Treasury sale proceeds/basis " +
  "stored at 100× economic value and short-sale rows with reversed proceeds/basis " +
  "columns in these exports. Stock gain/loss figures are unaffected, but reconcile " +
  "against broker records before using the CSV/TXF for any filing.";
```

Three changes:
1. Amber warning block (reuse the exact pattern at TaxReportCard.tsx:218-237 — `border border-amber-400/20 bg-amber-400/5 rounded-lg p-3`, heading `⚠ Export not ready for filing` in `text-xs font-medium text-amber-400`, body `text-[10px] text-ink-faint` rendering `{FILING_WARNING_COPY}`) directly under the card header (after :154), visually adjacent to the CSV/TXF buttons. Buttons stay enabled (user decision).
2. `handleDownload` (:95-112): downloaded filename → `` `form-8949-${year}-NOT-FOR-FILING.${format}` `` — the containment signal travels with the saved file.
3. `app/api/tax-report/route.ts` CSV/TXF branches: `Content-Disposition` filenames gain the same `-NOT-FOR-FILING` suffix (route currently says `form-8949-${year}.csv` / `tax-report-${year}.txf`).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { FILING_WARNING_COPY } from "@/app/dashboard/components/TaxReportCard";

describe("tax report filing warning", () => {
  it("names both defect classes and the audit date", () => {
    expect(FILING_WARNING_COPY).toContain("100×");
    expect(FILING_WARNING_COPY).toContain("short-sale");
    expect(FILING_WARNING_COPY).toContain("2026-08-21");
  });

  it("is rendered in the card JSX and stamps the download filename", () => {
    const src = readFileSync("app/dashboard/components/TaxReportCard.tsx", "utf8");
    expect(src).toMatch(/\{FILING_WARNING_COPY\}/);
    expect(src).toContain("Export not ready for filing");
    expect(src).toContain("NOT-FOR-FILING");
  });

  it("the API route stamps both export filenames", () => {
    const src = readFileSync("app/api/tax-report/route.ts", "utf8");
    const hits = src.match(/NOT-FOR-FILING/g) ?? [];
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run to verify FAIL** — `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/dashboard/tax-report-filing-warning.test.ts`
- [ ] **Step 3: Implement** the export, banner, and both filename changes.
- [ ] **Step 4: Run to verify PASS**, plus `tests/dashboard/tax-report-wash-sale-disclosure.test.ts` and `tests/compute/tax-report.test.ts` (untouched-green).
- [ ] **Step 5: Commit**

```bash
git add app/dashboard/components/TaxReportCard.tsx app/api/tax-report/route.ts tests/dashboard/tax-report-filing-warning.test.ts
git commit -F /tmp/msg-t5.txt   # "fix(tax): 8949/TXF exports bannered + filenamed not-for-filing (audit P0)"
```

---

### Task 6: TWR honesty relabel

**Files:**
- Modify: `app/dashboard/components/PerformanceView.tsx` (:262-288), `app/dashboard/components/analysis/TrustStripDrawer.tsx` (:211-272), `app/dashboard/components/analysis/TrustStrip.tsx` (:164-171)
- Test: `tests/dashboard/twr-reconcile-labels.test.ts` (new)

No logic changes — `reconcileTwrAgainstStatements` keeps working (it still usefully detects a MISSING statement TWR); only the claim and its visual tone change:

- `PerformanceView.tsx` within-tolerance branch: currently a green (`bg-up/10 text-up`) banner with `✓ TWR reconciled to {source} statement through <strong>{periodEnd}</strong> · +N bp within tolerance`.
  → **Neutral tone** (`bg-raised text-ink-dim border border-edge` — no success color, no ✓): `TWR from {reconciliation.source} statement through <strong>{periodEnd}</strong> · statement-reported — not independently verified`. Drop the bp figure in this branch entirely (`computeTwr` returns the statement value when present, so the figure is the statement compared with itself). Keep the ⚠ outside-tolerance branch and its bp figure, appending ` · check statement import`.
- `TrustStripDrawer.tsx` :218 → `Statement TWR present through ${performanceReconciledThru} — statement-reported, not independently verified.` After the per-account rows (:263), add a caption (`text-[10px] text-ink-faint`): `bp figures compare the app's stored value with the statement's own figure — not an independent recomputation.`
- `TrustStrip.tsx` cell (:164-171): label `Perf reconciled` → `Stmt TWR thru`; hint → `Latest month with a statement-reported TWR (not independently verified)`; tone stays informational, not `good`.

Internal names (`withinTolerance`, `performanceReconciledThru`, `divergenceBp`) are NOT renamed this round — that belongs to the future independent-reconciliation design (deferred by decision).

- [ ] **Step 1: Write the failing test** (source-text pattern, `tests/dashboard/data-confidence-indicator-privacy.test.ts` precedent):

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("TWR surfaces disclose non-independence (2026-08-21 audit)", () => {
  it("PerformanceView drops 'within tolerance' + success styling on the statement branch", () => {
    const src = readFileSync("app/dashboard/components/PerformanceView.tsx", "utf8");
    expect(src).toContain("statement-reported — not independently verified");
    expect(src).not.toMatch(/bp\b[^}]*within tolerance/s);
  });

  it("TrustStripDrawer discloses on the summary line and the bp caption", () => {
    const src = readFileSync("app/dashboard/components/analysis/TrustStripDrawer.tsx", "utf8");
    expect(src).toContain("not independently verified");
    expect(src).toContain("not an independent recomputation");
  });

  it("TrustStrip cell stops saying 'Perf reconciled'", () => {
    const src = readFileSync("app/dashboard/components/analysis/TrustStrip.tsx", "utf8");
    expect(src).not.toContain("Perf reconciled");
    expect(src).toContain("Stmt TWR thru");
  });
});
```

- [ ] **Step 2: Run to verify FAIL.**
- [ ] **Step 3: Apply the copy + tone changes.**
- [ ] **Step 4: Run to verify PASS**, plus `tests/queries/analysis-trust-state.test.ts` (untouched-green).
- [ ] **Step 5: Commit**

```bash
git add app/dashboard/components/PerformanceView.tsx app/dashboard/components/analysis/TrustStripDrawer.tsx app/dashboard/components/analysis/TrustStrip.tsx tests/dashboard/twr-reconcile-labels.test.ts
git commit -F /tmp/msg-t6.txt   # "fix(analysis): TWR surfaces disclose statement-reported, not independently verified"
```

---

### Task 7: Data Confidence → freshness-hint reframe

**Files:**
- Modify: `app/dashboard/components/DataConfidenceIndicator.tsx` (tooltip :142, popover header :158)
- Test: `tests/dashboard/data-confidence-freshness-label.test.ts` (new)

Copy-only (scoring, weights, `LEVEL_CONFIG`, and the query layer untouched — the cash-dimension behavior is Lane D):
- Tooltip (:142): → `` `Data freshness: ${score}% — an operational hint, not a certification — click for details` ``
- Popover header (:158): `Data Confidence: {score}%` → `Data Freshness: {score}%`, with a caption line beneath (`text-[10px] text-ink-faint`): `Operational freshness hint — does not certify that every displayed number is correct (2026-08-21 audit).`
- Naming note (Codex): the score still mixes cash/enrichment/valuation dimensions, so "freshness" is imperfect — kept per the user's decision and the audit's own phrasing; a rename lands with the long-term confidence redesign.

- [ ] **Step 1: Write the failing test:**

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("Data Confidence badge reframed as freshness hint", () => {
  const src = () => readFileSync("app/dashboard/components/DataConfidenceIndicator.tsx", "utf8");
  it("tooltip and header say freshness", () => {
    expect(src()).toContain("Data freshness:");
    expect(src()).toContain("Data Freshness:");
  });
  it("carries the not-a-certification caption", () => {
    expect(src()).toContain("does not certify");
  });
});
```

- [ ] **Step 2: Run to verify FAIL.** — `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/dashboard/data-confidence-freshness-label.test.ts`
- [ ] **Step 3: Apply the copy changes.**
- [ ] **Step 4: Run to verify PASS**, plus `tests/dashboard/data-confidence-indicator-privacy.test.ts`.
- [ ] **Step 5: Commit**

```bash
git add app/dashboard/components/DataConfidenceIndicator.tsx tests/dashboard/data-confidence-freshness-label.test.ts
git commit -F /tmp/msg-t7.txt   # "fix(confidence): badge reframed as operational freshness hint"
```

---

### Task 8: Cash-flow audit — `live-anchor-residual` classification + lifted seam collector

**Files:**
- Modify: `lib/compute/cash-flow-audit.ts`, `scripts/repair-missing-external-flows.ts`
- Test: `tests/compute/cash-flow-audit.test.ts` (extend), `tests/scripts/repair-missing-external-flows.test.ts` (extend one case; rest stays green)

**Interfaces:**
- Produces (from `lib/compute/cash-flow-audit.ts`):

```ts
// MOVED VERBATIM from scripts/repair-missing-external-flows.ts:167-174, now exported here;
// the script imports it from lib. PRESERVE ITS EXISTING SIGNATURE AND RETURN TYPE EXACTLY
// (whatever computeCashFlowResiduals' seamDatesByAccount param already accepts — do not
// change the container type while moving; keep the one-fetchAnchorSourceSeamDates-call-
// per-account shape, never a cross-account union).
export function collectSeamDatesByAccount(db: Database.Database, accountIds: number[]): /* existing type */;

// New sibling, SAME container type as the seam collector: dates whose monthly_snapshots
// anchor row has source IN LIVE_SNAPSHOT_SOURCES (import from lib/db/live-sources.ts —
// never inline 'plaid'/'tws'). Per-account query:
//   SELECT month_end_date FROM monthly_snapshots WHERE account_id = ? AND source IN (…)
export function collectLiveAnchorDatesByAccount(db: Database.Database, accountIds: number[]): /* same type */;

// Classification union gains "live-anchor-residual".
// computeCashFlowResiduals opts gain: liveAnchorDatesByAccount?: /* same type */
// Rule: a residual point whose interval END date (curr.valuation_date) is in the
// account's live-anchor set → classification "live-anchor-residual", UNLESS the seam
// rule already claimed it (precedence: source-seam > live-anchor-residual > existing).
// Omitted/empty map ⇒ byte-identical output (same contract the seam param honors).
```

Rationale (the audit's corrected-Roth finding made structural): on a day whose `monthly_snapshots` anchor is Plaid/TWS, `daily-valuation.ts:438-442` computes `cash_balance` as `snapshot_total − holdings_value` — an intraday broker total minus close-priced holdings. A day-over-day change in that plug is usually a measurement-timing artifact, not evidence of an external flow — but it is AMBIGUOUS until a statement covers the window, which is why Lane D labels rather than silently drops (Task 9). Classifying in the ENGINE means the flow-repair script's proposal path also can never propose synthesizing a deposit for one (the audit's explicit "do not synthesize" instruction).

In `scripts/repair-missing-external-flows.ts`: delete the local `collectSeamDatesByAccount`, import from `@/lib/compute/cash-flow-audit`; build `liveAnchorDatesByAccount` alongside the seam map and pass it in; extend `partitionCandidates` so `live-anchor-residual` points join the `seamPoints`-style informational partition and are NEVER proposal candidates.

- [ ] **Step 1: Write the failing tests** — extend `tests/compute/cash-flow-audit.test.ts` using its EXISTING fixture helpers (read the seam tests at :352-394 first; they are the template). Required behaviors, as real tests:
  1. a residual point whose end date has a `plaid`-sourced `monthly_snapshots` row, with the map from `collectLiveAnchorDatesByAccount`, classifies `"live-anchor-residual"`;
  2. a date in BOTH maps classifies `"source-seam"` (precedence);
  3. omitted vs empty `liveAnchorDatesByAccount` is byte-identical (mirror the seam test at :394);
  4. `collectLiveAnchorDatesByAccount` returns live-source dates only, per asked account (a `canonical` row and another account's `plaid` row are absent);
  5. (in `tests/scripts/repair-missing-external-flows.test.ts`) a live-anchored residual above the floor lands in the informational partition and produces NO proposal.

- [ ] **Step 2: Run to verify the new tests FAIL** and existing ones PASS:
`PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/compute/cash-flow-audit.test.ts tests/scripts/repair-missing-external-flows.test.ts`

- [ ] **Step 3: Implement** — move the seam collector, add the live-anchor collector + classification, rewire the script.

- [ ] **Step 4: Run to verify ALL PASS** (same command), then `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/compute/flow-adjusted-seams.test.ts tests/queries/data-confidence-cash-flow.test.ts` (untouched-green).

- [ ] **Step 5: Commit**

```bash
git add lib/compute/cash-flow-audit.ts scripts/repair-missing-external-flows.ts tests/compute/cash-flow-audit.test.ts tests/scripts/repair-missing-external-flows.test.ts
git commit -F /tmp/msg-t8.txt   # "feat(cash-audit): live-anchor-residual classification; seam collector lifted to lib"
```

---

### Task 9: Data Confidence cash dimension — suppress the cap, keep the label

**Files:**
- Modify: `lib/queries/data-confidence.ts` (`findWorstUnexplainedCashFlow` :263-298, warning application :358-376, `CashAccuracyScore` :44-63)
- Test: `tests/queries/data-confidence-cash-flow.test.ts` (extend)

**Interfaces (frozen return contract):**

```ts
export interface TimingResidualNote { date: string; accountName: string; amount: number }
// CashAccuracyScore gains:  timingResidual: TimingResidualNote | null
// findWorstUnexplainedCashFlow's return type becomes:
//   { unexplainedFlow: /* existing unexplainedFlow shape */ | null; timingResidual: TimingResidualNote | null }
```

Behavior:
1. `findWorstUnexplainedCashFlow` builds BOTH maps (`collectSeamDatesByAccount`, `collectLiveAnchorDatesByAccount`) for its non-IBKR account scope and passes them to `computeCashFlowResiduals`.
2. Candidate filter: `isUnexplainedCashFlow(p) && p.classification !== "source-seam" && p.classification !== "live-anchor-residual"` — explicit at this call site (`isUnexplainedCashFlow` ignores classification by design; keep that, matching `partitionCandidates`' division of labor).
3. The worst SUPPRESSED `live-anchor-residual` point that would otherwise have crossed the floors → `timingResidual` (else null). Seam points stay fully silent (already-understood measurement splices).
4. Warning application: `unexplainedFlow` keeps its existing cap + copy. `timingResidual`, when present and `unexplainedFlow` is null, does NOT cap the score; it appends to `detail`:
   `; cash delta of ${amountStr} on ${date} in ${accountName} is a live-snapshot timing residual (intraday broker total vs close-priced holdings) — not treated as an external flow`
   and sets `guidance`: `Live-snapshot (Plaid/TWS) days infer cash as snapshot-total minus holdings value; the residual usually moves with measurement timing, not money. A genuine flow in this window would confirm on the next statement import — verify there if the amount looks like a real deposit or withdrawal.`
   (The second sentence is deliberate — a real mid-month flow stays VISIBLE during statement lag, it just no longer caps the score or claims flow-shaped certainty.)

- [ ] **Step 1: Write the failing tests** — extend the existing describe (:46) using its fixture builders. Required behaviors, as real tests:
  1. an external-flow-shaped jump on a plaid-anchored day: score NOT capped; `unexplainedFlow` null; `detail` contains `live-snapshot timing residual`; `cashAccuracy.timingResidual.date` equals the jump date;
  2. the same jump on a `canonical`-anchored day: unchanged legacy behavior (cap + warning copy);
  3. a source-seam day: `unexplainedFlow` null AND `timingResidual` null (fully silent).

- [ ] **Step 2: Run to verify FAIL / existing PASS:** `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/queries/data-confidence-cash-flow.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify ALL PASS**, then the neighborhood: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/queries tests/compute/cash-flow-audit.test.ts`
- [ ] **Step 5: Commit**

```bash
git add lib/queries/data-confidence.ts tests/queries/data-confidence-cash-flow.test.ts
git commit -F /tmp/msg-t9.txt   # "fix(confidence): live-snapshot timing residuals labeled, not flagged as external flows"
```

---

## Final verification (after Task 9)

- [ ] `npm run verify:changed`
- [ ] `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run` — full suite green (≥6,235 + new tests)
- [ ] `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx next build` — compiles
- [ ] `npm run verify:smoke` (UI-visible changes — repo rule)
- [ ] Browser smoke (`npm run dev`): tax-lots page shows the filing banner and a `-NOT-FOR-FILING` download name; Analysis Trust Strip shows `Stmt TWR thru`; the performance banner is neutral-toned; header badge tooltip says "Data freshness"

## USER-RUN steps (live DB — explicit approval per action)

0. **Rehearse on a scratch copy first:** copy `data/vanguard.db` to a temp path, point the script at it (env/arg per the script's DB-path convention), run `--apply` there, and verify outcomes + the daily-identity line before touching the real DB.
1. Dry-run live (readonly connection — safe): `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx scripts/repair-security-type-corruption.ts` — review the evidence table + NEEDS-REVIEW list together. Cross-check the coupon rows against the relevant Vanguard statement PDF (source-document verification per the audit).
2. With approval: `--apply` (backs up first, single transaction), then verify on Today/Analysis: the repaired equity shows its full value under its real name; the Fixed Income table lists only real bonds; the two retyped stock headers say Stock; recomputed tax lots and the daily-identity check are clean.
3. **MANDATORY:** apply the CSV corrections the script printed to the canonical statement files (re-importing the uncorrected file would re-insert the bad coupon row under its freed key — Task 1's guard contains the metadata damage but not the duplicate row).
4. Never undo the import batches named by the script's warning (their undo deletes the repaired rows).
5. Mark the three related deep-QA ledger findings decided/fixed so the nightly fixer stops re-minting them.

## Explicitly OUT of scope (deferred by decision, filed as follow-ups)

- The tax-lots engine ÷100 / short-column fix (own spec, broker-reconciliation acceptance test).
- Independent Modified Dietz reconciliation lane; renaming `withinTolerance`/`performanceReconciledThru` internals; Data Confidence universe/coverage query fixes (audit §Data Confidence defects 1–5, 7).
- Import-preview surfacing of `upsertSecurity` guard refusals (today: console.warn only).
- The "freshness vs status" naming debate (Codex #12) — with the long-term confidence redesign.
- The noise-betas QA decision (separate DECISIONS-PENDING item, undecided).
- `data_quality` downgrades for Plaid-day rows (prior ruling: blanket 'estimated' on Plaid days is worse).
- Backup-failure / undo-cycle test matrices (Codex #16 remainder — `ensureBackup` is battle-tested; the never-undo warning covers the undo hazard).
- Sanitization sweep of pre-existing real amounts in committed docs (TODO backlog item added 2026-08-23).
