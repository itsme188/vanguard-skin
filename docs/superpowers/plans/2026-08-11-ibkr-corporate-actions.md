# IBKR Corporate Actions (Splits) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ingest the IBKR statement's Corporate Actions section (splits + reverse splits) as replay-native events so tax lots reconcile with the broker through a split, per `docs/superpowers/specs/2026-08-11-ibkr-corporate-actions-design.md` (issue #37).

**Architecture:** Parser emits `ParsedCorporateAction` rows; commit stores them in `corporate_actions` (`source='import'`, idempotent `source_key`, batch-tagged, resolve-only security lookup); `computeTaxLots` merges them into its chronological replay (open lots: qty ×ratio, per-share basis ÷ratio, end-of-day ordering) with an account-scoped delta cross-check persisted to `reconcile_delta`. No history rewrite; the manual rewrite road is untouched except for guards.

**Tech Stack:** TypeScript, better-sqlite3 (in-memory for tests), Vitest, Next.js API routes.

**Review:** two Codex plan-review rounds 2026-08-11, both REVISE, all findings applied. Round 1 (7): resolve-only security handling, real schema in all seeds (`accounts` is `(id, name)` only), true upgrade-style migration test, route-level tests + accurate route restructuring, CA counts in `recordCount`/summary/importability, full `ParsedImportResult`-literal sweep, edge-case roster. Round 2 (7): preview counts from `validatedResult`, post-split holdings seed for the valuation-continuity test (holdings are never split-adjusted by design), **holdings-snapshot sweep gate** (CA-only imports must not trigger purges/closed-equity reconcile), preview→commit route contract, undo-wording honesty (recompute failures are logged not raised — inherited), E2E fake-ticker seeding + cleanup, and the remaining edge tests (same-date buy, zero denominator, nonnumeric quantity, commit-time validation rejection, reconcile-delta refresh-to-NULL).

## Global Constraints

- Run tests with `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run <path>` (node@24 keg pin).
- Every DB function takes `db: Database.Database` as its first parameter (DI for tests).
- API envelope: `{success:true,...}` / `{success:false,error}`. In-app routes take no cron auth.
- Transaction types are UPPERCASE. Compare `security_type` case-insensitively.
- Commit messages: write to a temp file, `git commit -F <file>` — never inline `-m`.
- Fixtures in `tests/fixtures/` use FAKE tickers only (AAAA/BBBB/…); no real portfolio quantities.
- Schema facts verified 2026-08-11: `accounts(id, name)` — no other columns; `corporate_actions` business key `UNIQUE(security_id, action_type, effective_date)` (migration 018). Verify any OTHER table you seed against `lib/db/migrations/` before running.
- The spec is authoritative on semantics; where this plan and the spec disagree, the spec wins and the discrepancy gets flagged in review.

---

### Task 1: Migration 078 — corporate_actions import columns

**Files:**
- Create: `lib/db/migrations/078_corporate_actions_import.sql`
- Test: `tests/import/corporate-actions-migration.test.ts`

**Interfaces:**
- Produces: columns `source_key TEXT` (unique partial index `idx_corporate_actions_source_key`), `import_batch_id INTEGER`, `account_id INTEGER`, `quantity_delta REAL`, `reconcile_delta REAL` on `corporate_actions`. Later tasks INSERT/SELECT these exact names.

- [ ] **Step 1: Write the failing test** — a true UPGRADE test: migrate through 077, populate legacy rows, then apply 078.

```ts
// tests/import/corporate-actions-migration.test.ts
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runMigrations } from "@/lib/db/migrate";

const MIGRATIONS_DIR = join(__dirname, "../../lib/db/migrations");

/** Apply migrations strictly below the given number, in order. */
function migrateBelow(db: Database.Database, stopAt: number) {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const f of files) {
    const n = parseInt(f.slice(0, 3), 10);
    if (n >= stopAt) break;
    db.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf-8"));
  }
}

describe("migration 078: corporate_actions import columns", () => {
  it("applies cleanly over a populated 077 database (upgrade path)", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrateBelow(db, 78);
    // legacy manual row exists BEFORE 078 runs
    db.prepare("INSERT INTO securities (symbol) VALUES ('AAAA')").run();
    const secId = (db.prepare("SELECT id FROM securities WHERE symbol='AAAA'").get() as { id: number }).id;
    db.prepare(
      `INSERT INTO corporate_actions (security_id, action_type, effective_date, ratio_numerator, ratio_denominator, applied, source)
       VALUES (?, 'SPLIT', '2026-04-21', 8, 1, 1, 'manual')`,
    ).run(secId);

    db.exec(readFileSync(join(MIGRATIONS_DIR, "078_corporate_actions_import.sql"), "utf-8"));

    const cols = (db.prepare("PRAGMA table_info(corporate_actions)").all() as { name: string }[]).map((c) => c.name);
    for (const col of ["source_key", "import_batch_id", "account_id", "quantity_delta", "reconcile_delta"]) {
      expect(cols).toContain(col);
    }
    // legacy row untouched, new columns NULL
    const row = db.prepare("SELECT source_key, reconcile_delta, ratio_numerator FROM corporate_actions").get() as Record<string, unknown>;
    expect(row.source_key).toBeNull();
    expect(row.reconcile_delta).toBeNull();
    expect(row.ratio_numerator).toBe(8);
    // FK integrity holds after the upgrade
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("full runMigrations path exposes the columns and the partial unique index", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    db.prepare("INSERT INTO securities (symbol) VALUES ('AAAA')").run();
    const secId = (db.prepare("SELECT id FROM securities WHERE symbol='AAAA'").get() as { id: number }).id;
    const ins = db.prepare(
      `INSERT INTO corporate_actions (security_id, action_type, effective_date, ratio_numerator, ratio_denominator, applied, source, source_key)
       VALUES (?, 'SPLIT', ?, 4, 1, 0, 'import', ?)`,
    );
    ins.run(secId, "2026-07-01", "ibkr:ca:split:2026-07-01:AAAA:4:1");
    expect(() => ins.run(secId, "2026-07-02", "ibkr:ca:split:2026-07-01:AAAA:4:1")).toThrow(/UNIQUE/);
    // NULL source_keys coexist (manual rows) — different dates to dodge the business key
    db.prepare(
      `INSERT INTO corporate_actions (security_id, action_type, effective_date, ratio_numerator, ratio_denominator, applied, source)
       VALUES (?, 'SPLIT', '2026-07-03', 2, 1, 1, 'manual')`,
    ).run(secId);
    db.prepare(
      `INSERT INTO corporate_actions (security_id, action_type, effective_date, ratio_numerator, ratio_denominator, applied, source)
       VALUES (?, 'SPLIT', '2026-07-04', 2, 1, 1, 'manual')`,
    ).run(secId);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/import/corporate-actions-migration.test.ts`
Expected: FAIL — 078 file missing (`readFileSync` throws) and columns absent.

- [ ] **Step 3: Write the migration**

```sql
-- lib/db/migrations/078_corporate_actions_import.sql
-- Import-sourced corporate actions (spec 2026-08-11, issue #37).
-- source='import' rows are REPLAY-mode: computeTaxLots applies them
-- chronologically; history is never rewritten. source='manual' rows keep
-- the legacy rewrite semantics and are excluded from the replay.
ALTER TABLE corporate_actions ADD COLUMN source_key TEXT;
ALTER TABLE corporate_actions ADD COLUMN import_batch_id INTEGER REFERENCES import_batches(id);
-- account the statement evidence belongs to (delta cross-check scope);
-- the split itself applies to every account's lots.
ALTER TABLE corporate_actions ADD COLUMN account_id INTEGER REFERENCES accounts(id);
-- statement's Quantity column (share delta) — evidence, never the booking truth
ALTER TABLE corporate_actions ADD COLUMN quantity_delta REAL;
-- persisted cross-check result; NULL = clean (only meaningful after a successful replay)
ALTER TABLE corporate_actions ADD COLUMN reconcile_delta REAL;

CREATE UNIQUE INDEX idx_corporate_actions_source_key
  ON corporate_actions(source_key) WHERE source_key IS NOT NULL;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/import/corporate-actions-migration.test.ts`
Expected: PASS (2 tests). If `migrateBelow` breaks because the migration runner uses a different numbering/naming scheme, fix the helper to match the actual filenames — never the migration.

- [ ] **Step 5: Commit**

Write message to a temp file, then:
```bash
git add lib/db/migrations/078_corporate_actions_import.sql tests/import/corporate-actions-migration.test.ts
git commit -F /tmp/ca-commit-1.txt   # "feat(db): migration 078 — corporate_actions import columns (#37)"
```

---

### Task 2: Parser — Corporate Actions section

**Files:**
- Create: `tests/fixtures/ibkr-corporate-actions.csv`
- Modify: `lib/import/types.ts` (add `ParsedCorporateAction`, extend `ParsedImportResult`)
- Modify: `lib/import/parsers/ibkr-activity.ts` (CA pass)
- Modify: every other `ParsedImportResult` producer — all parsers in `lib/import/parsers/`, the `unknown` fallback in `lib/import/engine.ts::parseImport`, AND every object literal in tests/lib built as `ParsedImportResult` (sweep: `grep -rn "sourceType:" tests/ lib/ app/ --include='*.ts' --include='*.tsx'` and add `corporateActions: []` to each literal)
- Test: `tests/import/ibkr-corporate-actions-parser.test.ts`

**Interfaces:**
- Produces:
```ts
export interface ParsedCorporateAction {
  accountName: string;                       // "IBKR"
  symbol: string;                            // raw statement symbol (suffix-normalized later, at commit)
  actionType: "SPLIT" | "REVERSE_SPLIT";
  effectiveDate: string;                     // YYYY-MM-DD from the Date/Time column
  ratioNumerator: number;
  ratioDenominator: number;
  quantityDelta: number | null;              // statement Quantity column
  sourceKey: string;                         // ibkr:ca:split:<date>:<symbol>:<num>:<den>
}
// ParsedImportResult gains: corporateActions: ParsedCorporateAction[]  (REQUIRED field)
```

- [ ] **Step 1: Write the fixture**

```csv
Statement,Header,Field Name,Field Value
Statement,Data,Period,"July 1, 2026 - July 31, 2026"
Corporate Actions,Header,Asset Category,Currency,Account,Report Date,Date/Time,Description,Quantity,Proceeds,Value,Realized P/L,Code
Corporate Actions,Data,Stocks,USD,U0000000,2026-07-02,"2026-07-01, 20:25:00","AAAA(US0000000001) Split 4 for 1 (AAAA, FAKE ALPHA CORP, US0000000001)",300,0,0,0,
Corporate Actions,Data,Stocks,USD,U0000000,2026-07-16,"2026-07-15, 20:25:00","BBBB(US0000000002) Split 1 for 10 (BBBB, FAKE BETA CORP, US0000000002)",-90,0,0,0,
Corporate Actions,Data,Stocks,USD,U0000000,2026-07-20,"2026-07-19, 20:25:00","CCCC(US0000000003) Merged(Acquisition) FAKE GAMMA CORP (CCCC, FAKE GAMMA CORP, US0000000003)",-50,0,500,0,
Corporate Actions,Data,Stocks,USD,U0000000,2026-07-22,"2026-07-21, 20:25:00","DDDD(US0000000004) Split X for Y (DDDD, FAKE DELTA CORP, US0000000004)",7,0,0,0,
Corporate Actions,Data,Stocks,USD,U0000000,2026-07-23,"2026-07-22, 20:25:00","EEEE(US0000000005) Split 1 for 1 (EEEE, FAKE EPSILON CORP, US0000000005)",0,0,0,0,
Corporate Actions,Data,Equity and Index Options,USD,U0000000,2026-07-24,"2026-07-23, 20:25:00","AAAA 21AUG26 100 C Contract Adjustment",0,0,0,0,
Corporate Actions,Data,Stocks,USD,U0000000,2026-07-25,"2026-07-24, 20:25:00","402340.KS(KR7402340005) Split 2 for 1 (402340.KS, FAKE KOREA CO, KR7402340005)",10,0,0,0,
Corporate Actions,Data,Stocks,USD,U0000000,2026-07-26,"2026-07-25, 20:25:00","FFFF(US0000000006) Split 4 for 0 (FFFF, FAKE ZETA CORP, US0000000006)",0,0,0,0,
Corporate Actions,Data,Stocks,USD,U0000000,2026-07-27,"2026-07-26, 20:25:00","GGGG(US0000000007) Split 3 for 1 (GGGG, FAKE ETA CORP, US0000000007)",N/A,0,0,0,
Corporate Actions,Data,Total,,,,,,,0,0,0,
```

(FFFF pins the denominator-zero warning; GGGG pins nonnumeric `Quantity` → `quantityDelta: null` while still importing.)

- [ ] **Step 2: Write the failing test**

```ts
// tests/import/ibkr-corporate-actions-parser.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseIbkrActivity } from "@/lib/import/parsers/ibkr-activity";

const csv = readFileSync(join(__dirname, "../fixtures/ibkr-corporate-actions.csv"), "utf-8");

describe("ibkr-activity parser: Corporate Actions section", () => {
  const result = parseIbkrActivity(csv, "ibkr-corporate-actions.csv");

  it("parses the forward split with ratio from description and date from Date/Time", () => {
    const split = result.corporateActions.find((a) => a.symbol === "AAAA");
    expect(split).toMatchObject({
      accountName: "IBKR",
      actionType: "SPLIT",
      effectiveDate: "2026-07-01",       // NOT the 2026-07-02 report date
      ratioNumerator: 4,
      ratioDenominator: 1,
      quantityDelta: 300,
      sourceKey: "ibkr:ca:split:2026-07-01:AAAA:4:1",
    });
  });

  it("parses the reverse split (numerator < denominator)", () => {
    const rev = result.corporateActions.find((a) => a.symbol === "BBBB");
    expect(rev).toMatchObject({
      actionType: "REVERSE_SPLIT",
      ratioNumerator: 1,
      ratioDenominator: 10,
      quantityDelta: -90,
    });
  });

  it("keeps a dotted exchange-suffixed symbol intact (normalization happens at commit)", () => {
    const kr = result.corporateActions.find((a) => a.symbol === "402340.KS");
    expect(kr).toMatchObject({ actionType: "SPLIT", ratioNumerator: 2, ratioDenominator: 1 });
  });

  it("warns by name on merger, malformed, 1:1, zero-denominator, and option-adjustment rows", () => {
    expect(result.corporateActions).toHaveLength(4);   // AAAA, BBBB, 402340.KS, GGGG
    const joined = result.warnings.join("\n");
    expect(joined).toContain("CCCC");                  // merger
    expect(joined).toContain("DDDD");                  // Split X for Y
    expect(joined).toContain("EEEE");                  // 1-for-1 no-op
    expect(joined).toContain("FFFF");                  // Split 4 for 0
    expect(joined).toContain("Contract Adjustment");   // non-Stocks asset category
  });

  it("nonnumeric Quantity imports with quantityDelta null (evidence absent, not fabricated)", () => {
    const g = result.corporateActions.find((a) => a.symbol === "GGGG");
    expect(g).toMatchObject({ actionType: "SPLIT", ratioNumerator: 3, quantityDelta: null });
  });

  it("stays silent on the Total row", () => {
    expect(result.warnings.filter((w) => w.includes("Total"))).toHaveLength(0);
  });

  it("handles a header WITHOUT the Account column (single-account statements)", () => {
    const noAcct = [
      "Statement,Header,Field Name,Field Value",
      'Statement,Data,Period,"July 1, 2026 - July 31, 2026"',
      "Corporate Actions,Header,Asset Category,Currency,Report Date,Date/Time,Description,Quantity,Proceeds,Value,Realized P/L,Code",
      'Corporate Actions,Data,Stocks,USD,2026-07-02,"2026-07-01, 20:25:00","AAAA(US0000000001) Split 4 for 1 (AAAA, FAKE ALPHA CORP, US0000000001)",300,0,0,0,',
    ].join("\n");
    const r = parseIbkrActivity(noAcct, "no-account.csv");
    expect(r.corporateActions).toHaveLength(1);
    expect(r.corporateActions[0]).toMatchObject({ symbol: "AAAA", effectiveDate: "2026-07-01", quantityDelta: 300 });
  });

  it("rejects a calendar-invalid Date/Time with a warning", () => {
    const bad = [
      "Corporate Actions,Header,Asset Category,Currency,Account,Report Date,Date/Time,Description,Quantity,Proceeds,Value,Realized P/L,Code",
      'Corporate Actions,Data,Stocks,USD,U0,2026-07-02,"2026-13-45, 20:25:00","AAAA(US1) Split 4 for 1 (AAAA, X, US1)",300,0,0,0,',
    ].join("\n");
    const r = parseIbkrActivity(bad, "bad-date.csv");
    expect(r.corporateActions).toHaveLength(0);
    expect(r.warnings.join("\n")).toContain("AAAA");
  });

  it("statements without a Corporate Actions section produce an empty array", () => {
    const bare = parseIbkrActivity("Statement,Header,Field Name,Field Value\n", "bare.csv");
    expect(bare.corporateActions).toEqual([]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/import/ibkr-corporate-actions-parser.test.ts`
Expected: FAIL — `corporateActions` is undefined.

- [ ] **Step 4: Add the type, sweep the literals, then write the parser pass**

1. `lib/import/types.ts`: add `ParsedCorporateAction` (exact shape above) and `corporateActions: ParsedCorporateAction[];` to `ParsedImportResult`.
2. **Literal sweep:** `grep -rln "sourceType:" lib/ app/ tests/ --include='*.ts' --include='*.tsx'`, and for every object built as a `ParsedImportResult` (all parsers' return objects, `parseImport`'s `unknown` fallback, any test fixtures/literals) add `corporateActions: []`. Then run `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsc --noEmit` — it must come back clean; vitest does not typecheck, so tsc is the sweep verifier.
3. Parser pass in `lib/import/parsers/ibkr-activity.ts`, after the Transfers pass:

```ts
// Parse Corporate Actions (splits/reverse splits only — spec 2026-08-11).
// Columns by header name (single-account statements omit "Account").
// The ratio lives in the description text; Quantity is the share DELTA
// (reconciliation evidence, never the booking truth).
const isRealIsoDate = (s: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const corporateActions: ParsedCorporateAction[] = [];
const caHeader = rows.find(
  (r) => r.section === "Corporate Actions" && r.discriminator === "Header"
);
const cCol: Record<string, number> = {};
caHeader?.fields.forEach((name, i) => {
  cCol[name] = i;
});
for (const row of rows) {
  if (row.section !== "Corporate Actions" || row.discriminator !== "Data") continue;
  const assetCategory = row.fields[cCol["Asset Category"] ?? 0];
  if (assetCategory === "Total" || !assetCategory) continue;
  const description = row.fields[cCol["Description"] ?? 5] ?? "";
  if (assetCategory !== "Stocks") {
    warnings.push(
      `Corporate Actions: unsupported action skipped (non-stock ${assetCategory}) — "${description}"`
    );
    continue;
  }
  // Symbol = everything before the first "(" — dotted/suffixed symbols survive.
  const symMatch = description.match(/^([^(]+)\(/);
  const symbol = symMatch ? symMatch[1].trim() : "";
  const ratioMatch = description.match(/\bSplit (\d+) for (\d+)\b/);
  const dateStr = parseDatetime(row.fields[cCol["Date/Time"] ?? 4] ?? "");
  const qtyRaw = parseFloat((row.fields[cCol["Quantity"] ?? 6] ?? "").replace(/,/g, ""));
  if (!symbol || !ratioMatch || !isRealIsoDate(dateStr)) {
    warnings.push(`Corporate Actions: unsupported action skipped — "${description}"`);
    continue;
  }
  const num = parseInt(ratioMatch[1], 10);
  const den = parseInt(ratioMatch[2], 10);
  if (!Number.isFinite(num) || !Number.isFinite(den) || num <= 0 || den <= 0 || num === den) {
    // num === den (1-for-1) is a no-op that would still create a row — skip loudly.
    warnings.push(`Corporate Actions: unsupported action skipped (ratio) — "${description}"`);
    continue;
  }
  corporateActions.push({
    accountName: "IBKR",
    symbol,
    actionType: num > den ? "SPLIT" : "REVERSE_SPLIT",
    effectiveDate: dateStr,
    ratioNumerator: num,
    ratioDenominator: den,
    quantityDelta: Number.isFinite(qtyRaw) ? qtyRaw : null,
    sourceKey: `ibkr:ca:split:${dateStr}:${symbol}:${num}:${den}`,
  });
}
```

Import `ParsedCorporateAction` from `../types`; add `corporateActions` to the returned object.

- [ ] **Step 5: Run the new test + the whole import suite + tsc**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/import/ && PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsc --noEmit`
Expected: all PASS, tsc clean. Any pre-existing test failing on a missing `corporateActions` → fix the producer/literal, not the assertion.

- [ ] **Step 6: Commit**

```bash
git add lib/import/ tests/fixtures/ibkr-corporate-actions.csv tests/import/ibkr-corporate-actions-parser.test.ts
git commit -F /tmp/ca-commit-2.txt   # "feat(import): parse IBKR Corporate Actions section — splits/reverse splits (#37)"
```

---

### Task 3: Shared validation + manual-road guards

**Files:**
- Modify: `lib/compute/corporate-actions.ts`
- Modify: `app/api/corporate-actions/route.ts`
- Test: `tests/compute/corporate-actions-guards.test.ts`

**Interfaces:**
- Produces:
```ts
export class ImportedActionError extends Error {}
export function validateCorporateActionInput(params: {
  actionType: string; effectiveDate: string;
  ratioNumerator: number; ratioDenominator: number;
}): string | null;   // error message, or null when valid; rejects calendar-invalid dates
// undoCorporateAction throws ImportedActionError when the row's source === 'import'
```
- Consumes: migration 078 columns (Task 1).

- [ ] **Step 1: Write the failing test**

```ts
// tests/compute/corporate-actions-guards.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  validateCorporateActionInput,
  undoCorporateAction,
  ImportedActionError,
} from "@/lib/compute/corporate-actions";

describe("corporate-actions guards", () => {
  it("validateCorporateActionInput rejects bad ratios, bad dates, bad types", () => {
    const base = { actionType: "SPLIT", effectiveDate: "2026-07-01", ratioNumerator: 4, ratioDenominator: 1 };
    expect(validateCorporateActionInput(base)).toBeNull();
    expect(validateCorporateActionInput({ ...base, ratioNumerator: 0 })).toMatch(/ratio/i);
    expect(validateCorporateActionInput({ ...base, ratioDenominator: 0 })).toMatch(/ratio/i);
    expect(validateCorporateActionInput({ ...base, ratioNumerator: NaN })).toMatch(/ratio/i);
    expect(validateCorporateActionInput({ ...base, ratioNumerator: Infinity })).toMatch(/ratio/i);
    expect(validateCorporateActionInput({ ...base, effectiveDate: "07/01/2026" })).toMatch(/date/i);
    expect(validateCorporateActionInput({ ...base, effectiveDate: "2026-02-30" })).toMatch(/date/i);  // calendar-invalid
    expect(validateCorporateActionInput({ ...base, actionType: "MERGER" })).toMatch(/actionType/);
  });

  describe("undoCorporateAction import guard", () => {
    let db: Database.Database;
    let actionId: number;
    beforeEach(() => {
      db = new Database(":memory:");
      db.pragma("foreign_keys = ON");
      runMigrations(db);
      db.prepare("INSERT INTO securities (symbol) VALUES ('AAAA')").run();
      const secId = (db.prepare("SELECT id FROM securities WHERE symbol='AAAA'").get() as { id: number }).id;
      const r = db.prepare(
        `INSERT INTO corporate_actions
           (security_id, action_type, effective_date, ratio_numerator, ratio_denominator, applied, source, source_key)
         VALUES (?, 'SPLIT', '2026-07-01', 4, 1, 0, 'import', 'ibkr:ca:split:2026-07-01:AAAA:4:1')`,
      ).run(secId);
      actionId = Number(r.lastInsertRowid);
    });

    it("throws ImportedActionError and leaves the row in place", () => {
      expect(() => undoCorporateAction(db, actionId)).toThrow(ImportedActionError);
      const still = db.prepare("SELECT COUNT(*) AS c FROM corporate_actions WHERE id = ?").get(actionId) as { c: number };
      expect(still.c).toBe(1);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/compute/corporate-actions-guards.test.ts`
Expected: FAIL — exports missing.

- [ ] **Step 3: Implement in `lib/compute/corporate-actions.ts`**

```ts
export class ImportedActionError extends Error {}

export function validateCorporateActionInput(params: {
  actionType: string;
  effectiveDate: string;
  ratioNumerator: number;
  ratioDenominator: number;
}): string | null {
  if (!["SPLIT", "REVERSE_SPLIT"].includes(params.actionType)) {
    return "actionType must be SPLIT or REVERSE_SPLIT";
  }
  const d = params.effectiveDate;
  const isRealDate =
    /^\d{4}-\d{2}-\d{2}$/.test(d) &&
    !isNaN(new Date(d + "T00:00:00Z").getTime()) &&
    new Date(d + "T00:00:00Z").toISOString().slice(0, 10) === d;
  if (!isRealDate) {
    return "effectiveDate must be a real YYYY-MM-DD date";
  }
  for (const [name, v] of [
    ["ratioNumerator", params.ratioNumerator],
    ["ratioDenominator", params.ratioDenominator],
  ] as const) {
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      return `${name} must be a finite ratio component > 0`;
    }
  }
  return null;
}
```

`undoCorporateAction`: extend the initial SELECT with `source`, then before the transaction:

```ts
if (action.source === "import") {
  throw new ImportedActionError(
    "This action was imported from a broker statement — undo its import batch instead",
  );
}
```

`addCorporateAction`: call `validateCorporateActionInput({ ...params, ratioDenominator: params.ratioDenominator ?? 1 })` first; `throw new Error(message)` on non-null.

- [ ] **Step 4: Wire the route** (`app/api/corporate-actions/route.ts`)

- POST: before `addCorporateAction`, pre-check `SELECT id, source FROM corporate_actions WHERE security_id = ? AND effective_date = ?`; on a hit → 409 `{success:false, error:"A corporate action already exists for this security on <date>" + (source === 'import' ? " (imported from a statement — resolve via import)" : "")}`.
- DELETE: `catch` gains `if (error instanceof ImportedActionError) return NextResponse.json({ success: false, error: error.message }, { status: 403 });`

- [ ] **Step 5: Run tests**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/compute/`
Expected: PASS, no regressions.

- [ ] **Step 6: Commit**

```bash
git add lib/compute/corporate-actions.ts app/api/corporate-actions/route.ts tests/compute/corporate-actions-guards.test.ts
git commit -F /tmp/ca-commit-3.txt   # "feat(corp-actions): shared validation + import-row guards on the manual road (#37)"
```

---

### Task 4: computeTaxLots replay integration

**Files:**
- Modify: `lib/compute/tax-lots.ts`
- Test: `tests/compute/tax-lots-splits.test.ts`

**Interfaces:**
- Consumes: migration 078 columns.
- Produces: `TaxLotComputeResult` gains `replayWarnings: string[]`. Split application semantics per spec §4.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/compute/tax-lots-splits.test.ts
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeTaxLots } from "@/lib/compute/tax-lots";

function setup() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.prepare("INSERT INTO accounts (name) VALUES ('IBKR')").run();
  db.prepare("INSERT INTO accounts (name) VALUES ('Roth')").run();
  db.prepare("INSERT INTO securities (symbol) VALUES ('AAAA')").run();
  const ibkr = (db.prepare("SELECT id FROM accounts WHERE name='IBKR'").get() as { id: number }).id;
  const roth = (db.prepare("SELECT id FROM accounts WHERE name='Roth'").get() as { id: number }).id;
  const sec = (db.prepare("SELECT id FROM securities WHERE symbol='AAAA'").get() as { id: number }).id;
  return { db, ibkr, roth, sec };
}

function insertTxn(db: Database.Database, accountId: number, secId: number,
  date: string, type: string, qty: number, price: number, key: string) {
  db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, source_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  ).run(accountId, secId, date, type, qty, price, qty * price, key);
}

function insertSplit(db: Database.Database, secId: number, accountId: number | null,
  date: string, num: number, den: number, delta: number | null, source = "import") {
  db.prepare(
    `INSERT INTO corporate_actions
       (security_id, account_id, action_type, effective_date, ratio_numerator, ratio_denominator,
        applied, source, source_key, quantity_delta)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
  ).run(secId, accountId, num >= den ? "SPLIT" : "REVERSE_SPLIT", date, num, den, source,
        source === "import" ? `ibkr:ca:split:${date}:AAAA:${num}:${den}` : null, delta);
}

describe("computeTaxLots: import-sourced split replay", () => {
  it("adjusts an open lot: qty ×4, per-share ÷4, total basis and date unchanged; clean delta → NULL", () => {
    const { db, ibkr, sec } = setup();
    insertTxn(db, ibkr, sec, "2026-06-01", "BUY", 100, 400, "k1");
    insertSplit(db, sec, ibkr, "2026-07-01", 4, 1, 300);
    computeTaxLots(db);
    const lot = db.prepare("SELECT * FROM tax_lots").get() as Record<string, number | string>;
    expect(lot.quantity_acquired).toBeCloseTo(400);
    expect(lot.quantity_remaining).toBeCloseTo(400);
    expect(lot.acquisition_price).toBeCloseTo(100);
    expect(lot.cost_basis).toBeCloseTo(40000);
    expect(lot.acquisition_date).toBe("2026-06-01");
    const ca = db.prepare("SELECT reconcile_delta FROM corporate_actions").get() as { reconcile_delta: number | null };
    expect(ca.reconcile_delta).toBeNull();   // 100 × (4−1) = 300 = statement delta
  });

  it("post-split sell consumes post-split units with correct realized P&L", () => {
    const { db, ibkr, sec } = setup();
    insertTxn(db, ibkr, sec, "2026-06-01", "BUY", 100, 400, "k1");   // $40,000 basis
    insertSplit(db, sec, ibkr, "2026-07-01", 4, 1, 300);
    insertTxn(db, ibkr, sec, "2026-07-10", "SELL", 400, 110, "k2");
    computeTaxLots(db);
    const sale = db.prepare("SELECT * FROM tax_lot_sales").get() as Record<string, number>;
    expect(sale.quantity_sold).toBeCloseTo(400);
    expect(sale.cost_basis_allocated).toBeCloseTo(40000);
    expect(sale.proceeds).toBeCloseTo(44000);
    expect(sale.realized_gain_loss).toBeCloseTo(4000);
  });

  it("same-date sell processes BEFORE the split (end-of-day rule)", () => {
    const { db, ibkr, sec } = setup();
    insertTxn(db, ibkr, sec, "2026-06-01", "BUY", 100, 400, "k1");
    insertTxn(db, ibkr, sec, "2026-07-01", "SELL", 40, 420, "k2");   // split-day sell, pre-split units
    insertSplit(db, sec, ibkr, "2026-07-01", 4, 1, 180);             // 60 open × 3 = 180
    computeTaxLots(db);
    const sale = db.prepare("SELECT quantity_sold, cost_basis_allocated FROM tax_lot_sales").get() as Record<string, number>;
    expect(sale.quantity_sold).toBeCloseTo(40);                      // NOT 160
    expect(sale.cost_basis_allocated).toBeCloseTo(16000);
    const lot = db.prepare("SELECT quantity_remaining, acquisition_price FROM tax_lots").get() as Record<string, number>;
    expect(lot.quantity_remaining).toBeCloseTo(240);                 // (100−40) × 4
    expect(lot.acquisition_price).toBeCloseTo(100);
    const ca = db.prepare("SELECT reconcile_delta FROM corporate_actions").get() as { reconcile_delta: number | null };
    expect(ca.reconcile_delta).toBeNull();
  });

  it("fully-closed pre-split sales keep their original recorded units", () => {
    const { db, ibkr, sec } = setup();
    insertTxn(db, ibkr, sec, "2026-05-01", "BUY", 50, 380, "k1");
    insertTxn(db, ibkr, sec, "2026-06-01", "SELL", 50, 420, "k2");
    insertTxn(db, ibkr, sec, "2026-06-15", "BUY", 100, 400, "k3");
    insertSplit(db, sec, ibkr, "2026-07-01", 4, 1, 300);
    computeTaxLots(db);
    const closedSale = db.prepare("SELECT quantity_sold, realized_gain_loss FROM tax_lot_sales").get() as Record<string, number>;
    expect(closedSale.quantity_sold).toBeCloseTo(50);
    expect(closedSale.realized_gain_loss).toBeCloseTo(50 * (420 - 380));
  });

  it("sequential splits compose; reverse split divides", () => {
    const { db, ibkr, sec } = setup();
    insertTxn(db, ibkr, sec, "2026-05-01", "BUY", 100, 400, "k1");
    insertSplit(db, sec, ibkr, "2026-06-01", 2, 1, 100);
    insertSplit(db, sec, ibkr, "2026-07-01", 1, 10, -180);           // 200 → 20
    computeTaxLots(db);
    const lot = db.prepare("SELECT quantity_remaining, acquisition_price, cost_basis FROM tax_lots").get() as Record<string, number>;
    expect(lot.quantity_remaining).toBeCloseTo(20);
    expect(lot.acquisition_price).toBeCloseTo(2000);
    expect(lot.cost_basis).toBeCloseTo(40000);
  });

  it("fractional reverse-split result + cash-in-lieu delta → mismatch persisted (tripwire)", () => {
    const { db, ibkr, sec } = setup();
    insertTxn(db, ibkr, sec, "2026-05-01", "BUY", 75, 100, "k1");
    // pure ratio: 75 × (0.1 − 1) = −67.5; broker cashed the 0.5 fraction → statement says −68
    insertSplit(db, sec, ibkr, "2026-07-01", 1, 10, -68);
    const result = computeTaxLots(db);
    const lot = db.prepare("SELECT quantity_remaining FROM tax_lots").get() as { quantity_remaining: number };
    expect(lot.quantity_remaining).toBeCloseTo(7.5);                 // fractional retained (disclosed)
    const ca = db.prepare("SELECT reconcile_delta FROM corporate_actions").get() as { reconcile_delta: number | null };
    expect(ca.reconcile_delta).toBeCloseTo(0.5);                     // −67.5 − (−68)
    expect(result.replayWarnings.length).toBeGreaterThan(0);
  });

  it("manual-source rows are EXCLUDED from the replay (double-apply guard)", () => {
    const { db, ibkr, sec } = setup();
    insertTxn(db, ibkr, sec, "2026-06-01", "BUY", 400, 100, "k1");   // already post-split basis (manual rewrite ran)
    insertSplit(db, sec, ibkr, "2026-07-01", 4, 1, null, "manual");
    computeTaxLots(db);
    const lot = db.prepare("SELECT quantity_remaining, acquisition_price FROM tax_lots").get() as Record<string, number>;
    expect(lot.quantity_remaining).toBeCloseTo(400);                 // NOT 1600
    expect(lot.acquisition_price).toBeCloseTo(100);
  });

  it("split applies to ALL accounts' lots but cross-checks only the importing account", () => {
    const { db, ibkr, roth, sec } = setup();
    insertTxn(db, ibkr, sec, "2026-06-01", "BUY", 100, 400, "k1");
    insertTxn(db, roth, sec, "2026-06-01", "BUY", 10, 400, "k2");
    insertSplit(db, sec, ibkr, "2026-07-01", 4, 1, 300);             // matches IBKR's 100 × 3 only
    computeTaxLots(db);
    const rothLot = db.prepare("SELECT quantity_remaining FROM tax_lots WHERE account_id = ?").get(roth) as { quantity_remaining: number };
    expect(rothLot.quantity_remaining).toBeCloseTo(40);
    const ca = db.prepare("SELECT reconcile_delta FROM corporate_actions").get() as { reconcile_delta: number | null };
    expect(ca.reconcile_delta).toBeNull();                           // Roth's 30 not double-counted
  });

  it("no open lots → delta mismatch persisted + warning returned", () => {
    const { db, ibkr, sec } = setup();
    insertSplit(db, sec, ibkr, "2026-07-01", 4, 1, 300);
    const result = computeTaxLots(db);
    const ca = db.prepare("SELECT reconcile_delta FROM corporate_actions").get() as { reconcile_delta: number | null };
    expect(ca.reconcile_delta).toBeCloseTo(-300);                    // implied 0 − stated 300
    expect(result.replayWarnings.join("\n")).toContain("AAAA");
  });

  it("same-date BUY is split-adjusted (acquisition_date <= effective_date, end-of-day)", () => {
    const { db, ibkr, sec } = setup();
    insertTxn(db, ibkr, sec, "2026-07-01", "BUY", 100, 400, "k1");   // bought ON split day, pre-split units
    insertSplit(db, sec, ibkr, "2026-07-01", 4, 1, 300);
    computeTaxLots(db);
    const lot = db.prepare("SELECT quantity_remaining, acquisition_price FROM tax_lots").get() as Record<string, number>;
    expect(lot.quantity_remaining).toBeCloseTo(400);
    expect(lot.acquisition_price).toBeCloseTo(100);
  });

  it("a previously persisted mismatch refreshes back to NULL once the missing data lands", () => {
    const { db, ibkr, sec } = setup();
    insertSplit(db, sec, ibkr, "2026-07-01", 4, 1, 300);
    computeTaxLots(db);                                              // no lots → mismatch persisted
    let ca = db.prepare("SELECT reconcile_delta FROM corporate_actions").get() as { reconcile_delta: number | null };
    expect(ca.reconcile_delta).not.toBeNull();
    insertTxn(db, ibkr, sec, "2026-06-01", "BUY", 100, 400, "k1");   // the missing history arrives
    computeTaxLots(db);
    ca = db.prepare("SELECT reconcile_delta FROM corporate_actions").get() as { reconcile_delta: number | null };
    expect(ca.reconcile_delta).toBeNull();                           // each recompute refreshes it
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/compute/tax-lots-splits.test.ts`
Expected: FAIL — lots unadjusted, `replayWarnings` undefined. (If a failure is instead a seeding-SQL column mismatch, fix the seed per Global Constraints.)

- [ ] **Step 3: Implement in `lib/compute/tax-lots.ts`**

Add `replayWarnings: string[]` to `TaxLotComputeResult`. After the lot-creation loop, before the sells loop:

```ts
interface SplitEvent {
  id: number;
  security_id: number;
  account_id: number | null;
  effective_date: string;
  ratio: number;
  quantity_delta: number | null;
  symbol: string;
}
const splitEvents = db
  .prepare(
    `SELECT ca.id, ca.security_id, ca.account_id, ca.effective_date,
            CAST(ca.ratio_numerator AS REAL) / ca.ratio_denominator AS ratio,
            ca.quantity_delta, s.symbol
     FROM corporate_actions ca
     JOIN securities s ON s.id = ca.security_id
     WHERE ca.source = 'import'
     ORDER BY ca.effective_date, ca.id`,
  )
  .all() as SplitEvent[];
const replayWarnings: string[] = [];
const clearDelta = db.prepare("UPDATE corporate_actions SET reconcile_delta = NULL WHERE id = ?");
const setDelta = db.prepare("UPDATE corporate_actions SET reconcile_delta = ? WHERE id = ?");

const applySplitEvent = (ev: SplitEvent) => {
  // Cross-check scope: the importing account's open lots only (statement is
  // single-account evidence). The adjustment itself is market-wide.
  const preOpen = ev.account_id != null
    ? (db.prepare(
        `SELECT COALESCE(SUM(quantity_remaining), 0) AS q FROM tax_lots
         WHERE security_id = ? AND account_id = ? AND quantity_remaining > 0 AND acquisition_date <= ?`,
      ).get(ev.security_id, ev.account_id, ev.effective_date) as { q: number }).q
    : null;

  db.prepare(
    `UPDATE tax_lots
     SET quantity_acquired = quantity_acquired * ?,
         quantity_remaining = quantity_remaining * ?,
         acquisition_price = acquisition_price / ?
     WHERE security_id = ? AND quantity_remaining > 0 AND acquisition_date <= ?`,
  ).run(ev.ratio, ev.ratio, ev.ratio, ev.security_id, ev.effective_date);

  if (ev.quantity_delta != null && preOpen != null) {
    const implied = preOpen * (ev.ratio - 1);
    const delta = implied - ev.quantity_delta;
    if (Math.abs(delta) <= 1e-6) {
      clearDelta.run(ev.id);
    } else {
      setDelta.run(delta, ev.id);
      replayWarnings.push(
        `${ev.symbol} ${ev.effective_date} split: ledger-implied share delta differs from the statement's — the ledger may have been missing shares before the split`,
      );
    }
  } else {
    clearDelta.run(ev.id);
  }
};
```

Replace the sells loop with the merge (end-of-day rule: strict `<`, so a split-date sell processes first):

```ts
let nextEvent = 0;
for (const sell of sells) {
  while (nextEvent < splitEvents.length && splitEvents[nextEvent].effective_date < sell.trade_date) {
    applySplitEvent(splitEvents[nextEvent]);
    nextEvent++;
  }
  processSell(sell);
}
while (nextEvent < splitEvents.length) {
  applySplitEvent(splitEvents[nextEvent]);
  nextEvent++;
}
```

Return `replayWarnings` in the result object (all return paths).

- [ ] **Step 4: Run the new tests + the whole compute suite**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/compute/`
Expected: all PASS (no split events → merge degenerates to old behavior; existing tests must not regress).

- [ ] **Step 5: Commit**

```bash
git add lib/compute/tax-lots.ts tests/compute/tax-lots-splits.test.ts
git commit -F /tmp/ca-commit-4.txt   # "feat(tax-lots): replay import-sourced splits chronologically with delta cross-check (#37)"
```

---

### Task 5: Import engine — commit, collisions, undo, batch accounting

**Files:**
- Modify: `lib/import/engine.ts` (commit block, `CommitResult`, symbol normalization, `recordCount`/summary)
- Modify: `lib/import/validate.ts` (validate `corporateActions`; extend `SkippedRow.category` union with `"corporateAction"`)
- Modify: `lib/mutations/import-batches.ts` (`deleteImportBatch`)
- Test: `tests/import/engine-corporate-actions.test.ts`

**Interfaces:**
- Consumes: `ParsedCorporateAction` (Task 2), migration 078, `validateCorporateActionInput` (Task 3).
- Produces: `CommitResult` gains `newCorporateActions: number` and `warnings: string[]`; `recordCount` and the batch summary include corporate actions; `deleteImportBatch` deletes batch-tagged CA rows. **Security resolution is resolve-only:** a CA whose symbol has no existing securities row is skipped with a warning — never `upsertSecurity` (spec: "never a guessed security").

- [ ] **Step 1: Write the failing tests**

```ts
// tests/import/engine-corporate-actions.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { commitImport, undoImport } from "@/lib/import/engine";
import type { ParsedImportResult, ParsedCorporateAction } from "@/lib/import/types";

function base(overrides: Partial<ParsedImportResult> = {}): ParsedImportResult {
  return {
    sourceType: "ibkr-activity", sourceName: "test.csv",
    transactions: [], securities: [{ symbol: "AAAA", securityType: "Stock" }],
    holdings: [], prices: [], snapshots: [], corporateActions: [],
    errors: [], warnings: [], ...overrides,
  };
}
const SPLIT: ParsedCorporateAction = {
  accountName: "IBKR", symbol: "AAAA", actionType: "SPLIT",
  effectiveDate: "2026-07-01", ratioNumerator: 4, ratioDenominator: 1,
  quantityDelta: 300, sourceKey: "ibkr:ca:split:2026-07-01:AAAA:4:1",
};

describe("commitImport: corporate actions", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    db.prepare("INSERT INTO accounts (name) VALUES ('IBKR')").run();
  });

  it("inserts an import-sourced row tagged with batch + account; recordCount includes it", () => {
    const res = commitImport(db, base({ corporateActions: [SPLIT] }));
    expect(res.newCorporateActions).toBe(1);
    expect(res.recordCount).toBeGreaterThanOrEqual(1);   // CA counts as a record
    const row = db.prepare(
      `SELECT source, applied, source_key, import_batch_id, account_id, quantity_delta FROM corporate_actions`,
    ).get() as Record<string, unknown>;
    expect(row.source).toBe("import");
    expect(row.applied).toBe(0);
    expect(row.source_key).toBe(SPLIT.sourceKey);
    expect(row.import_batch_id).toBe(res.batchId);
    expect(row.quantity_delta).toBe(300);
    expect(row.account_id).not.toBeNull();
  });

  it("re-import is an idempotent no-op", () => {
    commitImport(db, base({ corporateActions: [SPLIT] }));
    const res2 = commitImport(db, base({ corporateActions: [SPLIT] }));
    expect(res2.newCorporateActions).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS c FROM corporate_actions").get() as { c: number }).c).toBe(1);
  });

  it("unknown security symbol → resolve-only: skipped with warning, NO securities row created", () => {
    const res = commitImport(db, base({
      securities: [],                                     // nothing pre-registers ZZZZ
      corporateActions: [{ ...SPLIT, symbol: "ZZZZ", sourceKey: "ibkr:ca:split:2026-07-01:ZZZZ:4:1" }],
    }));
    expect(res.newCorporateActions).toBe(0);
    expect(res.warnings.join("\n")).toContain("ZZZZ");
    expect((db.prepare("SELECT COUNT(*) AS c FROM securities WHERE symbol='ZZZZ'").get() as { c: number }).c).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS c FROM corporate_actions").get() as { c: number }).c).toBe(0);
  });

  it("same ratio + type as an existing manual row → silent skip", () => {
    db.prepare("INSERT INTO securities (symbol) VALUES ('AAAA')").run();
    const secId = (db.prepare("SELECT id FROM securities WHERE symbol='AAAA'").get() as { id: number }).id;
    db.prepare(
      `INSERT INTO corporate_actions (security_id, action_type, effective_date, ratio_numerator, ratio_denominator, applied, source)
       VALUES (?, 'SPLIT', '2026-07-01', 4, 1, 1, 'manual')`,
    ).run(secId);
    const res = commitImport(db, base({ corporateActions: [SPLIT] }));
    expect(res.newCorporateActions).toBe(0);
    expect(res.warnings).toHaveLength(0);
    expect((db.prepare("SELECT COUNT(*) AS c FROM corporate_actions").get() as { c: number }).c).toBe(1);
  });

  it("differing ratio (manual 2:1 vs statement 4:1) → skip + warning naming both", () => {
    db.prepare("INSERT INTO securities (symbol) VALUES ('AAAA')").run();
    const secId = (db.prepare("SELECT id FROM securities WHERE symbol='AAAA'").get() as { id: number }).id;
    db.prepare(
      `INSERT INTO corporate_actions (security_id, action_type, effective_date, ratio_numerator, ratio_denominator, applied, source)
       VALUES (?, 'SPLIT', '2026-07-01', 2, 1, 1, 'manual')`,
    ).run(secId);
    const res = commitImport(db, base({ corporateActions: [SPLIT] }));
    expect(res.newCorporateActions).toBe(0);
    expect(res.warnings.join("\n")).toMatch(/2:1/);
    expect(res.warnings.join("\n")).toMatch(/4:1/);
  });

  it("import-vs-import corrected ratio → skip + warning (INSERT OR IGNORE never swallows)", () => {
    commitImport(db, base({ corporateActions: [SPLIT] }));
    const corrected = { ...SPLIT, ratioNumerator: 2, sourceKey: "ibkr:ca:split:2026-07-01:AAAA:2:1" };
    const res = commitImport(db, base({ corporateActions: [corrected] }));
    expect(res.newCorporateActions).toBe(0);
    expect(res.warnings.join("\n")).toMatch(/4:1/);      // existing named
    expect(res.warnings.join("\n")).toMatch(/2:1/);      // incoming named
  });

  it("opposite type on the same security+date also warns (type-agnostic collision)", () => {
    db.prepare("INSERT INTO securities (symbol) VALUES ('AAAA')").run();
    const secId = (db.prepare("SELECT id FROM securities WHERE symbol='AAAA'").get() as { id: number }).id;
    db.prepare(
      `INSERT INTO corporate_actions (security_id, action_type, effective_date, ratio_numerator, ratio_denominator, applied, source)
       VALUES (?, 'REVERSE_SPLIT', '2026-07-01', 1, 10, 1, 'manual')`,
    ).run(secId);
    const res = commitImport(db, base({ corporateActions: [SPLIT] }));
    expect(res.newCorporateActions).toBe(0);
    expect(res.warnings.length).toBeGreaterThan(0);
  });

  it("duplicate-owner semantics: batch B re-imports the same CA, undoing batch A removes it (documented)", () => {
    const resA = commitImport(db, base({ corporateActions: [SPLIT] }));
    const resB = commitImport(db, base({ corporateActions: [SPLIT] }));
    expect(resB.newCorporateActions).toBe(0);            // B skipped it; A owns the row
    undoImport(db, resA.batchId);
    expect((db.prepare("SELECT COUNT(*) AS c FROM corporate_actions").get() as { c: number }).c).toBe(0);
  });

  it("undoImport removes the CA row and the recompute restores pre-split lots (recompute failures are logged, not raised — inherited undoImport semantics)", () => {
    db.prepare("INSERT INTO securities (symbol) VALUES ('AAAA')").run();
    const secId = (db.prepare("SELECT id FROM securities WHERE symbol='AAAA'").get() as { id: number }).id;
    const acctId = (db.prepare("SELECT id FROM accounts WHERE name='IBKR'").get() as { id: number }).id;
    db.prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, source_key)
       VALUES (?, ?, '2026-06-01', 'BUY', 100, 400, 40000, 0, 'seed-buy')`,
    ).run(acctId, secId);
    const res = commitImport(db, base({ corporateActions: [SPLIT] }));
    undoImport(db, res.batchId);
    expect((db.prepare("SELECT COUNT(*) AS c FROM corporate_actions").get() as { c: number }).c).toBe(0);
    const lot = db.prepare("SELECT quantity_remaining FROM tax_lots").get() as { quantity_remaining: number };
    expect(lot.quantity_remaining).toBeCloseTo(100);
  });

  it("CA-only import does NOT trigger the holdings-snapshot sweeps (purges / closed-equity reconcile)", () => {
    // Seed a live holding that the closed-equity reconciler would zero out if
    // it ran against this import's EMPTY holdings snapshot.
    db.prepare("INSERT INTO securities (symbol) VALUES ('AAAA')").run();
    const secId = (db.prepare("SELECT id FROM securities WHERE symbol='AAAA'").get() as { id: number }).id;
    const acctId = (db.prepare("SELECT id FROM accounts WHERE name='IBKR'").get() as { id: number }).id;
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
       VALUES (?, ?, 100, '2026-06-30', 'seed-h1')`,
    ).run(acctId, secId);
    commitImport(db, base({ corporateActions: [SPLIT] }));   // holdings: [] — no snapshot evidence
    const h = db.prepare("SELECT quantity FROM holdings WHERE security_id = ?").get(secId) as { quantity: number };
    expect(h.quantity).toBe(100);                            // untouched — no zero-row, no purge
  });

  it("an invalid CA row is excluded by validation before commit", () => {
    const res = commitImport(db, base({
      corporateActions: [{ ...SPLIT, effectiveDate: "2026-02-30", sourceKey: "ibkr:ca:split:2026-02-30:AAAA:4:1" }],
    }));
    expect(res.newCorporateActions).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS c FROM corporate_actions").get() as { c: number }).c).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/import/engine-corporate-actions.test.ts`
Expected: FAIL — `newCorporateActions` undefined.

- [ ] **Step 3: Implement**

`lib/import/validate.ts`: extend the union — `category: "transaction" | "holding" | "price" | "snapshot" | "security" | "corporateAction"` — and add a pass over `parsed.corporateActions` rejecting rows where `validateCorporateActionInput(...)` (imported from `@/lib/compute/corporate-actions`) returns non-null; excluded rows go to `skippedRows` with category `"corporateAction"`.

`lib/import/engine.ts`:
1. `resolveIbkrExchangeSuffixedSymbols`: add `for (const ca of parsed.corporateActions) { ca.symbol = resolveIbkrExchangeSuffixedSymbol(ca.symbol); }`.
2. `CommitResult`: add `newCorporateActions: number; warnings: string[];`.
3. In `commitImport`'s transaction, after the transactions loop (new locals `newCorporateActions = 0`, `warnings: string[] = []` beside the other counters):

```ts
// 3b. Insert corporate actions (spec 2026-08-11 §3). Collision check is
// TYPE-AGNOSTIC on (security_id, effective_date). Security resolution is
// RESOLVE-ONLY — a split on a symbol we've never seen means missing
// history; creating a bare securities row would be a guess.
const insertCa = db.prepare(`
  INSERT OR IGNORE INTO corporate_actions
    (security_id, account_id, action_type, effective_date, ratio_numerator,
     ratio_denominator, applied, source, source_key, import_batch_id, quantity_delta)
  VALUES (?, ?, ?, ?, ?, ?, 0, 'import', ?, ?, ?)
`);
const findCollision = db.prepare(`
  SELECT action_type, ratio_numerator, ratio_denominator, source
  FROM corporate_actions WHERE security_id = ? AND effective_date = ?
`);
const findSecurity = db.prepare("SELECT id FROM securities WHERE symbol = ?");
for (const ca of parsed.corporateActions) {
  const secRow = findSecurity.get(ca.symbol) as { id: number } | undefined;
  if (!secRow) {
    warnings.push(
      `Corporate action skipped: no known security for symbol ${ca.symbol} — import the trades/holdings that establish it first`,
    );
    continue;
  }
  const accountId = getAccountId(ca.accountName);
  const existing = findCollision.get(secRow.id, ca.effectiveDate) as
    | { action_type: string; ratio_numerator: number; ratio_denominator: number; source: string }
    | undefined;
  if (existing) {
    const sameShape =
      existing.action_type === ca.actionType &&
      existing.ratio_numerator === ca.ratioNumerator &&
      existing.ratio_denominator === ca.ratioDenominator;
    if (!sameShape) {
      warnings.push(
        `Corporate action conflict for ${ca.symbol} on ${ca.effectiveDate}: existing ${existing.source} ` +
        `${existing.action_type} ${existing.ratio_numerator}:${existing.ratio_denominator} vs statement ` +
        `${ca.actionType} ${ca.ratioNumerator}:${ca.ratioDenominator} — resolve manually`,
      );
    }
    skippedDuplicates++;
    continue;
  }
  const res = insertCa.run(
    secRow.id, accountId, ca.actionType, ca.effectiveDate,
    ca.ratioNumerator, ca.ratioDenominator, ca.sourceKey, batch.id, ca.quantityDelta,
  );
  if (res.changes > 0) newCorporateActions++;
  else skippedDuplicates++;
}
```

4. Batch accounting (step 9 in `commitImport`): `recordCount` adds `+ newCorporateActions`; the summary array gains `newCorporateActions > 0 ? \`${newCorporateActions} corporate actions\` : null`.
5. Return `newCorporateActions` and `warnings` in the `CommitResult`.
6. **Holdings-snapshot sweep gate (Codex R2-6):** the post-import sweeps (expired-option/matured-bond purges + `reconcileClosedEquityHoldings`, currently gated on source TYPE around `engine.ts:678`) must additionally require snapshot EVIDENCE: run them only when `parsed.holdings.length > 0`. A CA-only (or transactions-only) ibkr-activity import carries no holdings snapshot — running a closed-equity reconcile against an empty snapshot is the mass-close hazard the 50% shrink guard only partially bounds. One-line condition change + the CA-only test above pins it.

`lib/mutations/import-batches.ts::deleteImportBatch`: add `db.prepare("DELETE FROM corporate_actions WHERE import_batch_id = ?").run(batchId);` beside the other batch-scoped deletes (before `import_batches` itself).

- [ ] **Step 4: Run tests + full import suite**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/import/`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/import/engine.ts lib/import/validate.ts lib/mutations/import-batches.ts tests/import/engine-corporate-actions.test.ts
git commit -F /tmp/ca-commit-5.txt   # "feat(import): commit corporate actions — collisions, resolve-only, batch undo + accounting (#37)"
```

---

### Task 6: Import route replay status + preview & security-detail UI

**Files:**
- Modify: `app/api/import/route.ts`
- Modify: `app/dashboard/components/ImportFlow.tsx` (preview sample + warnings + importability)
- Modify: `app/dashboard/components/CorporateActionsSection.tsx`
- Modify: `lib/compute/corporate-actions.ts` (`listCorporateActions` returns `sourceKey`/`reconcileDelta`/`quantityDelta`)
- Test: `tests/api/import-corporate-actions-route.test.ts`

**Interfaces:**
- Consumes: `CommitResult.warnings` / `newCorporateActions` (Task 5), `replayWarnings` (Task 4).
- Produces: commit response gains `replay: { status: "clean" | "mismatch" | "failed"; warnings: string[] } | null` (null when no file in the request carried corporate actions). Preview `preview` object gains `corporateActions: { count: number; sample: Array<{ symbol: string; description: string; effectiveDate: string }> }`.

**Route structure fact (verified):** the route loops over files calling `commitImport` per file, then runs `classifySecurities`/`computeTaxLots`/`computeDailyValuations` ONCE after the loop, each in a silent try/catch. The replay status therefore aggregates across ALL files in the request.

- [ ] **Step 1: Write the failing route tests** — import the route handler directly, following the existing pattern in `tests/api/` (find a test there that builds a `NextRequest` against a route `POST`/`DELETE` export and mirror its setup; if `tests/api` mocks `@/lib/db`, mirror that mock with an in-memory migrated DB).

```ts
// tests/api/import-corporate-actions-route.test.ts
// Three contracts to pin (write them in the tests/api house style):
// 1. POST /api/import?mode=commit with a CA-bearing file →
//    response.data.replay.status === "clean" when reconcile is clean,
//    "mismatch" (with warnings array) when the delta mismatches,
//    and commitResult warnings appear in the response.
// 2. DELETE /api/corporate-actions?id=<import row> → 403, envelope
//    {success:false, error:/import batch/}.
// 3. POST /api/corporate-actions colliding with an existing action on
//    (security, date) → 409, domain-language error.
// 4. POST /api/import?mode=preview with the Task 2 fixture → preview payload
//    carries corporateActions.count (validated) + sample rows + warnings,
//    and the same parsed content then commits to the same counts (the
//    spec's preview → commit disposable-DB flow).
// If tests/api has no route-handler harness to mirror, pin contracts 2-4
// at the lib layer (undoCorporateAction throw + route pre-check query +
// validateParsedResult composition) and note the gap in the task report —
// do NOT invent a new harness style.
```

Also include the lib-layer composition pin (this part is exact):

```ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { commitImport } from "@/lib/import/engine";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import type { ParsedImportResult } from "@/lib/import/types";

describe("CA-bearing commit → synchronous replay status composition", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    db.prepare("INSERT INTO accounts (name) VALUES ('IBKR')").run();
  });

  it("mismatch replay surfaces warnings + persisted delta", () => {
    const parsed: ParsedImportResult = {
      sourceType: "ibkr-activity", sourceName: "t.csv",
      transactions: [], securities: [{ symbol: "AAAA", securityType: "Stock" }],
      holdings: [], prices: [], snapshots: [],
      corporateActions: [{
        accountName: "IBKR", symbol: "AAAA", actionType: "SPLIT",
        effectiveDate: "2026-07-01", ratioNumerator: 4, ratioDenominator: 1,
        quantityDelta: 300, sourceKey: "ibkr:ca:split:2026-07-01:AAAA:4:1",
      }],
      errors: [], warnings: [],
    };
    const res = commitImport(db, parsed);
    expect(res.newCorporateActions).toBe(1);
    const replay = computeTaxLots(db);            // no lots → mismatch
    expect(replay.replayWarnings.length).toBeGreaterThan(0);
    const delta = (db.prepare("SELECT reconcile_delta FROM corporate_actions").get() as { reconcile_delta: number | null }).reconcile_delta;
    expect(delta).toBeCloseTo(-300);
  });
});
```

- [ ] **Step 2: Run to verify the route tests fail**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/api/import-corporate-actions-route.test.ts`
Expected: route-contract tests FAIL (no `replay` in response); composition pin PASSES.

- [ ] **Step 3: Wire the route** (`app/api/import/route.ts`)

In the post-loop recompute block (`mode === "commit"`), replace the silent `computeTaxLots` try/catch:

```ts
const hadCorporateActions = commitResults.some(
  (r) => (r.newCorporateActions ?? 0) > 0 || (r.warnings ?? []).length > 0,
);
let replay: { status: "clean" | "mismatch" | "failed"; warnings: string[] } | null = null;
try {
  const lotResult = computeTaxLots(db);
  if (hadCorporateActions) {
    replay = lotResult.replayWarnings.length > 0
      ? { status: "mismatch", warnings: lotResult.replayWarnings }
      : { status: "clean", warnings: [] };
  }
} catch (err) {
  console.error("[import] tax-lot recompute failed:", err);
  if (hadCorporateActions) {
    replay = { status: "failed", warnings: ["Tax-lot recompute failed — reconcile status unknown"] };
  }
}
```

(Adapt `commitResults` to the route's actual per-file result collection variable.) Include `replay`, each file's `newCorporateActions`, and `warnings` in the response payload. In the preview branch, add the `corporateActions` block to the `preview` object — **built from `validatedResult.corporateActions`, not the raw parse** (the route deliberately previews only what validation will let commit; previewing raw rows could show a row that then silently fails to import):

```ts
corporateActions: {
  count: validatedResult.corporateActions.length,
  sample: validatedResult.corporateActions.slice(0, 5).map((ca) => ({
    symbol: ca.symbol,
    description: `${ca.ratioNumerator}:${ca.ratioDenominator} ${ca.actionType === "SPLIT" ? "split" : "reverse split"}`,
    effectiveDate: ca.effectiveDate,
  })),
},
```

- [ ] **Step 4: Preview UI + importability** (`ImportFlow.tsx`)

- Extend the component's local `PreviewResult`/response types with the new `corporateActions` and `replay` fields.
- Render a "Corporate actions" preview block (count + sample rows like `AAAA — 4:1 split — effective 2026-07-01`) following the existing per-category preview markup; render parser/commit `warnings` in the existing warnings surface.
- **Importability:** find the derived value gating the Import/Confirm button (the record-count/`canImport` computation) and include `corporateActions.count` — a statement containing ONLY a corporate action must be importable.
- After commit: `data.replay?.status === "mismatch"` → render the warnings; `"failed"` → render the failure line. Reuse `<Chip>` and existing list markup; no new primitives.

- [ ] **Step 5: Security-detail rendering** (`CorporateActionsSection.tsx` + `listCorporateActions`)

- `listCorporateActions`: add `source_key AS sourceKey, reconcile_delta AS reconcileDelta, quantity_delta AS quantityDelta` to both SELECTs; extend the exported `CorporateAction` interface with `sourceKey: string | null; reconcileDelta: number | null; quantityDelta: number | null;` and update the component's local interface to match.
- Rows with `source === "import"`: show an "imported" `<Chip>`; do NOT render the Undo button (the API would 403 — no dead controls); add `title="Imported from a statement — remove via import undo"` on the chip.
- When `reconcileDelta != null`: render `Reconcile: ledger-implied delta differs from statement by <Shares value={action.reconcileDelta} /> — review lots`, using `<Shares>` from `lib/privacy/components.tsx` (portfolio-derived share count must mask in privacy mode).

- [ ] **Step 6: Run the suites + build**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/api/ tests/import/ tests/compute/`
Expected: PASS.
Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx next build`
Expected: clean compile (catches route/component type drift).

- [ ] **Step 7: Commit**

```bash
git add app/api/import/route.ts app/dashboard/components/ImportFlow.tsx app/dashboard/components/CorporateActionsSection.tsx lib/compute/corporate-actions.ts tests/api/import-corporate-actions-route.test.ts
git commit -F /tmp/ca-commit-6.txt   # "feat(import): replay status + preview/security-detail corporate-action surfaces (#37)"
```

---

### Task 7: Disposable-DB integration test + full suite + E2E

**Files:**
- Test: `tests/import/corporate-actions-integration.test.ts`

**Interfaces:**
- Consumes: everything above; the sanitized fixture from Task 2.

- [ ] **Step 1: Write the integration test** — before writing, verify `daily_valuations` and `holdings` column names against `lib/db/migrations/` (or an existing test seeding them) and use the real names; the assertions below are the contract.

```ts
// tests/import/corporate-actions-integration.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runMigrations } from "@/lib/db/migrate";
import { parseImport, commitImport, undoImport } from "@/lib/import/engine";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { computeDailyValuations } from "@/lib/compute/daily-valuation";

const csv = readFileSync(join(__dirname, "../fixtures/ibkr-corporate-actions.csv"), "utf-8");

describe("corporate actions end-to-end (disposable DB)", () => {
  let db: Database.Database;
  let acct: number;
  let sec: number;
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    db.prepare("INSERT INTO accounts (name) VALUES ('IBKR')").run();
    acct = (db.prepare("SELECT id FROM accounts WHERE name='IBKR'").get() as { id: number }).id;
    db.prepare("INSERT INTO securities (symbol) VALUES ('AAAA')").run();
    db.prepare("INSERT INTO securities (symbol) VALUES ('BBBB')").run();
    db.prepare("INSERT INTO securities (symbol) VALUES ('402340')").run();  // suffix-normalized target
    db.prepare("INSERT INTO securities (symbol) VALUES ('GGGG')").run();    // null-delta row's security
    sec = (db.prepare("SELECT id FROM securities WHERE symbol='AAAA'").get() as { id: number }).id;
    db.prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, source_key)
       VALUES (?, ?, '2026-06-01', 'BUY', 100, 400, 40000, 0, 'seed-buy')`,
    ).run(acct, sec);
    // Holdings + prices on BOTH sides of the split. Corporate actions never
    // touch holdings rows — each statement snapshot is already in its own
    // date's basis — so valuation continuity requires a post-split holdings
    // row (400 shares) exactly as a real post-split statement would carry.
    // (Verify holdings column list against the schema before running.)
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
       VALUES (?, ?, 100, '2026-06-30', 'seed-h1')`,
    ).run(acct, sec);
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
       VALUES (?, ?, 400, '2026-07-02', 'seed-h2')`,
    ).run(acct, sec);
    db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2026-06-30', 400, 'test')").run(sec);
    db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2026-07-02', 100, 'test')").run(sec);
  });

  it("import → recompute → invariants → valuation continuity → undo → restore → re-import idempotent", async () => {
    const parsed = await parseImport(csv, "ibkr-corporate-actions.csv");
    const commit1 = commitImport(db, parsed);
    expect(commit1.newCorporateActions).toBe(4);   // AAAA split, BBBB reverse, 402340 (suffix-normalized), GGGG (null delta)

    computeTaxLots(db);
    const lot = db.prepare("SELECT quantity_remaining, acquisition_price, cost_basis FROM tax_lots WHERE security_id = ?").get(sec) as Record<string, number>;
    expect(lot.quantity_remaining).toBeCloseTo(400);
    expect(lot.acquisition_price).toBeCloseTo(100);
    expect(lot.cost_basis).toBeCloseTo(40000);      // total basis invariant

    // Valuation continuity across the split — UNCONDITIONAL: both rows must exist
    computeDailyValuations(db);
    const vals = db.prepare(
      `SELECT total_value FROM daily_valuations
       WHERE valuation_date IN ('2026-06-30','2026-07-02') ORDER BY valuation_date`,
    ).all() as Array<{ total_value: number }>;
    expect(vals).toHaveLength(2);
    expect(Math.abs(vals[1].total_value - vals[0].total_value)).toBeLessThan(vals[0].total_value * 0.01);

    // Undo restores pre-split lots
    undoImport(db, commit1.batchId);
    expect((db.prepare("SELECT COUNT(*) AS c FROM corporate_actions").get() as { c: number }).c).toBe(0);
    const lotAfterUndo = db.prepare("SELECT quantity_remaining, acquisition_price FROM tax_lots WHERE security_id = ?").get(sec) as Record<string, number>;
    expect(lotAfterUndo.quantity_remaining).toBeCloseTo(100);
    expect(lotAfterUndo.acquisition_price).toBeCloseTo(400);

    // Re-import after undo: rows land again; second re-import is a no-op
    const commit2 = commitImport(db, await parseImport(csv, "ibkr-corporate-actions.csv"));
    expect(commit2.newCorporateActions).toBe(4);
    const commit3 = commitImport(db, await parseImport(csv, "ibkr-corporate-actions.csv"));
    expect(commit3.newCorporateActions).toBe(0);
  });
});
```

- [ ] **Step 2: Run the integration test**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/import/corporate-actions-integration.test.ts`
Expected: PASS. If `daily_valuations` produces no rows because the engine requires more seed data (e.g., account-level cash rows), extend the seed until `vals` has both rows — do NOT weaken the `toHaveLength(2)` assertion.

- [ ] **Step 3: Full suite + build**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run`
Expected: entire suite green (4,677 baseline + new tests). Report exact counts.
Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx next build`
Expected: clean compile.

- [ ] **Step 4: Browser E2E** (dispatch agent-browser against the dev server)

Preconditions: `npm run dev` on :3000 (dev DB). **Seed first** (resolve-only means unknown fake tickers would be skipped at commit): insert securities AAAA/BBBB/402340/GGGG plus one AAAA BUY transaction into the dev DB via a small seed script; record their ids for cleanup. Script: Import tab → upload `tests/fixtures/ibkr-corporate-actions.csv` → preview shows "Corporate actions: 4" with the AAAA 4:1 sample AND the unsupported-action warnings (CCCC merger, DDDD malformed, EEEE 1:1, option adjustment) → the Import button is ENABLED (CA-only importability) → Confirm → result panel shows the commit summary incl. corporate actions → AAAA security-detail page → Corporate Actions section lists the imported row with the "imported" chip and no Undo button → toggle privacy mode → any reconcile-delta share count masks. Screenshot each step. **Cleanup:** undo the import batch through the UI, then delete the seeded fake securities/transactions.

- [ ] **Step 5: Commit**

```bash
git add tests/import/corporate-actions-integration.test.ts
git commit -F /tmp/ca-commit-7.txt   # "test(import): corporate-actions disposable-DB integration coverage (#37)"
```

---

## Post-merge (separate, explicitly authorized — NOT part of task execution)

Per spec §8 and the user's session decision: after merge + green suite, with the user's explicit go in-session — back up `data/vanguard.db`, re-import the July 2026 IBKR statement through the UI, let the synchronous replay run, verify the live split case's invariants + broker trajectory + idempotent second import, then close issue #37 with sanitized evidence and update `docs/plans/TODO.md`.

## Self-review notes

- Spec §1–§8 each map to Tasks 1–7 (§7 Mac/Worker parity needs no code — rationale ships in the issue close).
- Codex plan-review findings 1–7 all addressed: resolve-only security (T5), real schema seeds (all tasks), upgrade migration test (T1), route tests + accurate restructuring (T6), CA batch accounting (T5), literal sweep + importability (T2/T6), edge-case roster (T2/T4/T5).
- Type names consistent across tasks: `ParsedCorporateAction`, `newCorporateActions`, `replayWarnings`, `reconcile_delta`/`reconcileDelta`.
