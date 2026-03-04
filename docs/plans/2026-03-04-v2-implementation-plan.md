# Vanguard Skin v2 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rebuild the local-first portfolio dashboard from scratch with Claude-powered PDF parsing, unified import flow, tab-based UI, proper migrations, and GitHub safety from commit #1.

**Architecture:** Next.js 16 app router with SQLite (better-sqlite3), Claude API for PDF extraction, papaparse for CSVs, Recharts for charts. Server components for data, client components for interactivity. All imports go through a unified parse → preview → confirm flow.

**Tech Stack:** Next.js 16, React 19, TypeScript 5, Tailwind CSS 4, SQLite/better-sqlite3, Recharts, @anthropic-ai/sdk, papaparse, Vitest

---

## Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `next.config.ts`
- Create: `app/layout.tsx`
- Create: `app/page.tsx`
- Create: `app/globals.css`
- Create: `.gitignore`
- Create: `.env.local.example`
- Create: `CLAUDE.md`

**Step 1: Initialize Next.js project**

Run: `cd /Users/Yitzi/code/vanguard-skin && npx create-next-app@latest . --typescript --tailwind --eslint --app --src-dir=false --import-alias="@/*" --use-npm --turbopack`

Note: If the directory isn't empty, you may need to answer prompts. Accept defaults.

**Step 2: Install core dependencies**

Run:
```bash
npm install better-sqlite3 @anthropic-ai/sdk papaparse recharts lucide-react
npm install -D @types/better-sqlite3 @types/papaparse vitest
```

**Step 3: Create .gitignore**

Ensure these are in `.gitignore` (add to what create-next-app generates):
```
data/
.env.local
tests/fixtures/real/
```

**Step 4: Create .env.local.example**

```
ANTHROPIC_API_KEY=your-key-here
```

**Step 5: Create CLAUDE.md**

Write project instructions covering: tech stack, architecture, data flow, directories, API pattern, workflow rules, data pipeline conventions, core principles. Reference the design doc at `docs/plans/2026-03-04-v2-rebuild-design.md` for full architecture.

Key rules to include:
- All dates are YYYY-MM-DD
- Monthly snapshots always use last-day-of-month
- All DB reads go through `lib/queries/`, all writes through `lib/mutations/`
- Every import creates an `import_batches` record
- Source keys make imports idempotent
- Never use `rm -rf` with relative paths
- Commit and push at every milestone

**Step 6: Update next.config.ts**

```typescript
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
```

Note: `output: "standalone"` is NOT needed yet — that's for desktop packaging later.

**Step 7: Verify it runs**

Run: `npm run dev`
Expected: Next.js dev server starts, default page loads at http://localhost:3000

**Step 8: Commit and push**

```bash
git add -A
git commit -m "feat: project scaffold with core dependencies"
git push
```

---

## Task 2: Database Layer + Migration System

**Files:**
- Create: `lib/db.ts`
- Create: `lib/db/migrate.ts`
- Create: `lib/db/migrations/001_initial_schema.sql`
- Create: `lib/db/migrations/002_seed_accounts.sql`
- Create: `tests/db/migrate.test.ts`
- Create: `vitest.config.ts`

**Step 1: Write the migration test**

Create `tests/db/migrate.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

describe("migration system", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
  });

  it("creates schema_migrations table", () => {
    runMigrations(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
      .get();
    expect(tables).toBeTruthy();
  });

  it("applies all migrations", () => {
    runMigrations(db);
    const applied = db
      .prepare("SELECT COUNT(*) as count FROM schema_migrations")
      .get() as { count: number };
    expect(applied.count).toBeGreaterThanOrEqual(2);
  });

  it("creates all expected tables", () => {
    runMigrations(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("accounts");
    expect(names).toContain("securities");
    expect(names).toContain("transactions");
    expect(names).toContain("holdings");
    expect(names).toContain("prices");
    expect(names).toContain("monthly_snapshots");
    expect(names).toContain("tax_lots");
    expect(names).toContain("import_batches");
  });

  it("seeds three accounts", () => {
    runMigrations(db);
    const accounts = db.prepare("SELECT name FROM accounts ORDER BY id").all() as { name: string }[];
    expect(accounts).toEqual([
      { name: "Vanguard Taxable" },
      { name: "Vanguard Roth IRA" },
      { name: "IBKR" },
    ]);
  });

  it("is idempotent — running twice does not fail", () => {
    runMigrations(db);
    runMigrations(db);
    const applied = db
      .prepare("SELECT COUNT(*) as count FROM schema_migrations")
      .get() as { count: number };
    expect(applied.count).toBeGreaterThanOrEqual(2);
  });
});
```

**Step 2: Create vitest.config.ts**

```typescript
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
```

**Step 3: Run test to verify it fails**

Run: `npx vitest run tests/db/migrate.test.ts`
Expected: FAIL — `runMigrations` not found

**Step 4: Create lib/db/migrate.ts**

```typescript
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const MIGRATIONS_DIR = path.join(__dirname, "migrations");

export function runMigrations(db: Database.Database): void {
  // Create tracking table
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      applied_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Get already-applied migrations
  const applied = new Set(
    (db.prepare("SELECT filename FROM schema_migrations").all() as { filename: string }[])
      .map((r) => r.filename)
  );

  // Read and sort migration files
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  // Apply each unapplied migration in a transaction
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8");
    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (filename) VALUES (?)").run(file);
    })();
  }
}
```

**Step 5: Create 001_initial_schema.sql**

```sql
CREATE TABLE accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE securities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL UNIQUE,
  name TEXT,
  security_type TEXT,
  asset_class TEXT,
  source_key TEXT
);

CREATE TABLE import_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT,
  source_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed',
  record_count INTEGER DEFAULT 0,
  summary TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  security_id INTEGER,
  import_batch_id INTEGER,
  trade_date TEXT NOT NULL,
  settlement_date TEXT,
  type TEXT NOT NULL,
  quantity REAL,
  amount REAL,
  price_per_share REAL,
  fees REAL DEFAULT 0,
  is_external_flow INTEGER DEFAULT 0,
  source_key TEXT UNIQUE,
  notes TEXT,
  FOREIGN KEY(account_id) REFERENCES accounts(id),
  FOREIGN KEY(security_id) REFERENCES securities(id),
  FOREIGN KEY(import_batch_id) REFERENCES import_batches(id)
);

CREATE TABLE holdings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  security_id INTEGER NOT NULL,
  quantity REAL NOT NULL,
  cost_basis REAL,
  as_of_date TEXT NOT NULL,
  import_batch_id INTEGER,
  source_key TEXT UNIQUE,
  FOREIGN KEY(account_id) REFERENCES accounts(id),
  FOREIGN KEY(security_id) REFERENCES securities(id),
  FOREIGN KEY(import_batch_id) REFERENCES import_batches(id),
  UNIQUE(account_id, security_id, as_of_date)
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  security_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  close_price REAL NOT NULL,
  source TEXT DEFAULT 'manual',
  import_batch_id INTEGER,
  FOREIGN KEY(security_id) REFERENCES securities(id),
  FOREIGN KEY(import_batch_id) REFERENCES import_batches(id),
  UNIQUE(security_id, date)
);

CREATE TABLE daily_valuations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  valuation_date TEXT NOT NULL,
  cash_balance REAL NOT NULL,
  holdings_value REAL NOT NULL,
  total_value REAL NOT NULL,
  FOREIGN KEY(account_id) REFERENCES accounts(id),
  UNIQUE(account_id, valuation_date)
);

CREATE TABLE raw_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_batch_id INTEGER NOT NULL,
  raw_data TEXT NOT NULL,
  FOREIGN KEY(import_batch_id) REFERENCES import_batches(id)
);

CREATE TABLE reconciliation_checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  checkpoint_date TEXT NOT NULL,
  statement_value REAL NOT NULL,
  computed_value REAL,
  difference REAL,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(account_id) REFERENCES accounts(id),
  UNIQUE(account_id, checkpoint_date)
);

CREATE TABLE tax_lots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  security_id INTEGER NOT NULL,
  acquisition_transaction_id INTEGER,
  acquisition_date TEXT NOT NULL,
  acquisition_price REAL NOT NULL,
  quantity_acquired REAL NOT NULL,
  quantity_remaining REAL NOT NULL,
  cost_basis REAL NOT NULL,
  is_from_opening_snapshot INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(account_id) REFERENCES accounts(id),
  FOREIGN KEY(security_id) REFERENCES securities(id),
  FOREIGN KEY(acquisition_transaction_id) REFERENCES transactions(id)
);

CREATE INDEX idx_tax_lots_account_security
  ON tax_lots(account_id, security_id, acquisition_date);

CREATE TABLE tax_lot_sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tax_lot_id INTEGER NOT NULL,
  sale_transaction_id INTEGER NOT NULL,
  quantity_sold REAL NOT NULL,
  sale_price REAL NOT NULL,
  proceeds REAL NOT NULL,
  cost_basis_allocated REAL NOT NULL,
  realized_gain_loss REAL NOT NULL,
  is_long_term INTEGER NOT NULL,
  holding_period_days INTEGER NOT NULL,
  sale_date TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(tax_lot_id) REFERENCES tax_lots(id),
  FOREIGN KEY(sale_transaction_id) REFERENCES transactions(id)
);

CREATE INDEX idx_tax_lot_sales_transaction ON tax_lot_sales(sale_transaction_id);
CREATE INDEX idx_tax_lot_sales_date ON tax_lot_sales(sale_date);

CREATE TABLE monthly_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  month_end_date TEXT NOT NULL,
  total_value REAL NOT NULL,
  source TEXT DEFAULT 'manual',
  notes TEXT,
  starting_value REAL,
  mark_to_market REAL,
  deposits_withdrawals REAL,
  dividends REAL,
  interest REAL,
  commissions REAL,
  fees REAL,
  other_pnl REAL,
  twr REAL,
  investment_gain REAL,
  import_batch_id INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(account_id) REFERENCES accounts(id),
  FOREIGN KEY(import_batch_id) REFERENCES import_batches(id),
  UNIQUE(account_id, month_end_date)
);

CREATE INDEX idx_monthly_snapshots_date ON monthly_snapshots(month_end_date);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('start_date', '2025-01-01'),
  ('opening_snapshot_asof', '2024-12-31');
```

**Step 6: Create 002_seed_accounts.sql**

```sql
INSERT OR IGNORE INTO accounts (name) VALUES ('Vanguard Taxable');
INSERT OR IGNORE INTO accounts (name) VALUES ('Vanguard Roth IRA');
INSERT OR IGNORE INTO accounts (name) VALUES ('IBKR');
```

**Step 7: Create lib/db.ts**

```typescript
import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { runMigrations } from "./db/migrate";

const dataDir = process.env.VANGUARD_DB_DIR || path.join(process.cwd(), "data");
const dbPath = path.join(dataDir, "vanguard.db");

fs.mkdirSync(dataDir, { recursive: true });

export const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

runMigrations(db);
```

**Step 8: Run tests**

Run: `npx vitest run tests/db/migrate.test.ts`
Expected: All 5 tests pass

**Step 9: Commit and push**

```bash
git add -A
git commit -m "feat: database layer with migration system and initial schema"
git push
```

---

## Task 3: Core Query and Mutation Layers

**Files:**
- Create: `lib/queries/accounts.ts`
- Create: `lib/queries/securities.ts`
- Create: `lib/queries/monthly-snapshots.ts`
- Create: `lib/queries/import-batches.ts`
- Create: `lib/mutations/securities.ts`
- Create: `lib/mutations/import-batches.ts`
- Create: `lib/types.ts`
- Create: `tests/queries/accounts.test.ts`

**Step 1: Write tests for account queries**

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getAllAccounts, getAccountByName } from "@/lib/queries/accounts";

describe("account queries", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("returns all three seeded accounts", () => {
    const accounts = getAllAccounts(db);
    expect(accounts).toHaveLength(3);
    expect(accounts.map((a) => a.name)).toEqual([
      "Vanguard Taxable",
      "Vanguard Roth IRA",
      "IBKR",
    ]);
  });

  it("finds account by name", () => {
    const account = getAccountByName(db, "IBKR");
    expect(account).toBeTruthy();
    expect(account!.name).toBe("IBKR");
  });

  it("returns null for unknown account", () => {
    const account = getAccountByName(db, "Unknown");
    expect(account).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/queries/accounts.test.ts`
Expected: FAIL

**Step 3: Create lib/types.ts**

Define shared TypeScript types for accounts, securities, transactions, holdings, import batches, monthly snapshots. These are the row types returned from the database.

**Step 4: Create lib/queries/accounts.ts**

```typescript
import type Database from "better-sqlite3";
import type { Account } from "@/lib/types";

export function getAllAccounts(db: Database.Database): Account[] {
  return db.prepare("SELECT id, name FROM accounts ORDER BY id").all() as Account[];
}

export function getAccountByName(db: Database.Database, name: string): Account | null {
  return (db.prepare("SELECT id, name FROM accounts WHERE name = ?").get(name) as Account) ?? null;
}
```

**Step 5: Create lib/queries/securities.ts, monthly-snapshots.ts, import-batches.ts**

Similar pattern — typed query functions that accept a `Database.Database` parameter so they're testable with in-memory DBs.

**Step 6: Create lib/mutations/securities.ts**

```typescript
import type Database from "better-sqlite3";

export function upsertSecurity(
  db: Database.Database,
  symbol: string,
  name?: string,
  securityType?: string,
  assetClass?: string
): number {
  const existing = db
    .prepare("SELECT id FROM securities WHERE symbol = ?")
    .get(symbol) as { id: number } | undefined;
  if (existing) return existing.id;

  const result = db
    .prepare("INSERT INTO securities (symbol, name, security_type, asset_class) VALUES (?, ?, ?, ?)")
    .run(symbol, name ?? null, securityType ?? null, assetClass ?? null);
  return result.lastInsertRowid as number;
}
```

**Step 7: Create lib/mutations/import-batches.ts**

Functions: `createImportBatch`, `completeImportBatch`, `deleteImportBatch` (cascading delete for undo).

**Step 8: Run all tests**

Run: `npx vitest run`
Expected: All tests pass

**Step 9: Commit and push**

```bash
git add -A
git commit -m "feat: query and mutation layers for accounts, securities, imports"
git push
```

---

## Task 4: Import Type System + File Detection

**Files:**
- Create: `lib/import/types.ts`
- Create: `lib/import/detect.ts`
- Create: `tests/import/detect.test.ts`

**Step 1: Write tests for file detection**

Test cases:
- IBKR activity CSV (starts with "Statement,Header,Field Name,Field Value")
- IBKR holdings CSV (header: "account,symbol,name,type,quantity,price,cost_basis,balance")
- Vanguard cost basis CSV (header contains "symbol,name,type,account,cost_basis_method")
- Vanguard holdings CSV (header: "symbol,name,type,price,quantity,value")
- Monthly values CSV (header contains "date" and at least one account column)
- PDF files (starts with %PDF)
- Unknown format returns null

**Step 2: Create lib/import/types.ts**

Define `ParsedImportResult` — the universal return type from all parsers:
```typescript
export interface ParsedImportResult {
  sourceType: string;
  sourceName: string;
  transactions: ParsedTransaction[];
  securities: ParsedSecurity[];
  holdings: ParsedHolding[];
  prices: ParsedPrice[];
  snapshots: ParsedSnapshot[];
  errors: string[];
  warnings: string[];
}
```

Plus the individual parsed record types.

**Step 3: Create lib/import/detect.ts**

Examines file content (first 5 lines for CSV, magic bytes for PDF) and returns the source type.

**Step 4: Run tests, verify pass**

**Step 5: Commit and push**

```bash
git add -A
git commit -m "feat: import type system and file format detection"
git push
```

---

## Task 5: IBKR CSV Parsers

**Files:**
- Create: `lib/import/parsers/ibkr-activity.ts`
- Create: `lib/import/parsers/ibkr-holdings.ts`
- Create: `lib/import/parsers/monthly-values.ts`
- Create: `tests/import/parsers/ibkr-activity.test.ts`
- Create: `tests/import/parsers/ibkr-holdings.test.ts`
- Create: `tests/fixtures/ibkr-activity-sample.csv`
- Create: `tests/fixtures/ibkr-holdings-sample.csv`

**Step 1: Create anonymized test fixtures**

Based on real IBKR CSV structure (the format from `~/Desktop/Portfolio - Dashboard/data/ibkr/`). Use fake symbols and amounts.

**Step 2: Write tests for IBKR activity parser**

Test that given an IBKR activity CSV, the parser extracts:
- Monthly NAV (starting value, ending value, P&L breakdown)
- Trades (buys, sells with symbol, quantity, price, date)
- Dividends
- Interest
- Fees/commissions
- Securities list

**Step 3: Implement parsers**

The IBKR activity CSV has sections identified by the first column:
- `Statement,Data` → metadata
- `Net Asset Value,Data` → NAV breakdown
- `Change in NAV,Data` → P&L components
- `Mark-to-Market Performance Summary,Data` → per-security P&L
- `Trades,Data` → individual trades
- `Dividends,Data` → dividend records
- etc.

Parse section by section, build up the `ParsedImportResult`.

**Step 4: Write tests for IBKR holdings parser**

Simpler: parse the CSV with headers `account,symbol,name,type,quantity,price,cost_basis,balance`.

**Step 5: Write tests for monthly values parser**

Parse CSV with headers `date,month,year,ibkr` (and potentially `vanguard_taxable`, `vanguard_roth`).

**Step 6: Run all tests**

Run: `npx vitest run`
Expected: All tests pass

**Step 7: Commit and push**

```bash
git add -A
git commit -m "feat: IBKR CSV parsers (activity, holdings, monthly values)"
git push
```

---

## Task 6: Vanguard CSV Parsers

**Files:**
- Create: `lib/import/parsers/vanguard-cost-basis.ts`
- Create: `lib/import/parsers/vanguard-holdings.ts`
- Create: `tests/import/parsers/vanguard-cost-basis.test.ts`
- Create: `tests/import/parsers/vanguard-holdings.test.ts`
- Create: `tests/fixtures/vanguard-cost-basis-sample.csv`
- Create: `tests/fixtures/vanguard-holdings-sample.csv`

**Step 1: Create anonymized test fixtures**

Based on real Vanguard CSV structure.

**Step 2: Write and implement Vanguard cost basis parser**

Headers: `symbol,name,type,account,cost_basis_method,quantity,cost_per_share,total_cost,market_value,...`
Extract: tax lot records with acquisition cost, current value, gain/loss.

**Step 3: Write and implement Vanguard holdings parser**

Headers: `symbol,name,type,price,quantity,value`
Extract: securities and current holdings.

**Step 4: Run all tests, commit and push**

```bash
git add -A
git commit -m "feat: Vanguard CSV parsers (cost basis, holdings)"
git push
```

---

## Task 7: Claude PDF Parser (Vanguard Statements)

**Files:**
- Create: `lib/import/parsers/vanguard-pdf.ts`
- Create: `tests/import/parsers/vanguard-pdf.test.ts`
- Create: `tests/fixtures/vanguard-pdf-claude-response.json`

**Step 1: Create a mock Claude response fixture**

Run Claude API once manually against a real Vanguard statement PDF. Save the response JSON as `tests/fixtures/vanguard-pdf-claude-response.json`. This is what we test against — we mock the API call in tests.

**Step 2: Write tests**

Test that given a Claude API response JSON, the parser correctly extracts:
- Account name + statement period
- Holdings (symbol, name, quantity, value)
- Transactions (date, type, symbol, quantity, amount)
- Monthly total value
- Cash balance

**Step 3: Implement the parser**

Two parts:
1. `callClaudeForPdfExtraction(pdfBuffer: Buffer): Promise<ClaudePdfResponse>` — sends the PDF to Claude API as a document, asks for structured JSON
2. `parseClaudePdfResponse(response: ClaudePdfResponse): ParsedImportResult` — transforms the Claude response into our standard import format

The Claude prompt should request a specific JSON schema so the response is deterministic and parseable.

**Step 4: Run tests (using mock fixture)**

Run: `npx vitest run tests/import/parsers/vanguard-pdf.test.ts`
Expected: Pass

**Step 5: Commit and push**

```bash
git add -A
git commit -m "feat: Claude-powered Vanguard PDF parser"
git push
```

---

## Task 8: Unified Import Engine

**Files:**
- Create: `lib/import/engine.ts`
- Create: `tests/import/engine.test.ts`

**Step 1: Write tests for the import engine**

Test the full flow: detect format → parse → return preview. Then: confirm → write to database.

```typescript
describe("import engine", () => {
  it("detects and parses IBKR activity CSV", async () => {
    const result = await parseImport(ibkrCsvContent, "IBKR 2025-01 activity.csv");
    expect(result.sourceType).toBe("ibkr-activity");
    expect(result.transactions.length).toBeGreaterThan(0);
    expect(result.snapshots.length).toBe(1);
  });

  it("commits parsed data to database", () => {
    const batch = commitImport(db, parsedResult);
    expect(batch.recordCount).toBeGreaterThan(0);
    // Verify data in DB
    const txns = db.prepare("SELECT COUNT(*) as c FROM transactions").get();
    expect(txns.c).toBeGreaterThan(0);
  });

  it("is idempotent — re-importing same data creates no duplicates", () => {
    commitImport(db, parsedResult);
    commitImport(db, parsedResult);
    const txns = db.prepare("SELECT COUNT(*) as c FROM transactions").get();
    // Same count as single import
  });
});
```

**Step 2: Implement lib/import/engine.ts**

Three main functions:
- `parseImport(content: string | Buffer, filename: string): Promise<ParsedImportResult>` — detect + parse
- `commitImport(db: Database, parsed: ParsedImportResult): ImportBatch` — write to DB atomically
- `undoImport(db: Database, batchId: number): void` — delete all records from a batch

**Step 3: Run tests, commit and push**

```bash
git add -A
git commit -m "feat: unified import engine with detect/parse/commit/undo"
git push
```

---

## Task 9: Import API Route

**Files:**
- Create: `app/api/import/route.ts`

**Step 1: Create the unified import endpoint**

POST `/api/import` — accepts multipart form data with one or more files.

Two modes:
- `?mode=preview` — parse only, return preview JSON
- `?mode=commit` — parse and commit to database

Response shape:
```json
{
  "success": true,
  "data": {
    "sourceType": "ibkr-activity",
    "sourceName": "IBKR 2025-01 activity.csv",
    "preview": {
      "transactionCount": 47,
      "securityCount": 12,
      "snapshotCount": 1,
      "holdingCount": 0,
      "priceCount": 15
    },
    "details": { ... },
    "batchId": 1
  }
}
```

**Step 2: Commit and push**

```bash
git add -A
git commit -m "feat: unified import API endpoint"
git push
```

---

## Task 10: Dashboard — Layout + Overview Tab

**Files:**
- Create: `app/dashboard/layout.tsx`
- Create: `app/dashboard/page.tsx`
- Create: `app/dashboard/components/TabNav.tsx`
- Create: `app/dashboard/components/AccountSummaryCards.tsx`
- Create: `app/dashboard/components/CombinedPortfolioChart.tsx`
- Create: `app/dashboard/components/PerformanceMetrics.tsx`
- Create: `lib/queries/dashboard.ts`

**Step 1: Create tab navigation layout**

The dashboard layout renders a horizontal tab bar (Overview | Accounts | Import | Tax Lots | Reconciliation | Chat) and a content area. Use Next.js parallel routes or simple client-side tab state.

**Step 2: Create the Overview page**

Server component that queries:
- All accounts with their latest monthly snapshot values
- Monthly snapshots for the combined portfolio chart
- Basic performance metrics (total value, total change, overall TWR)

**Step 3: Create AccountSummaryCards**

Three cards showing each account's latest value, monthly change, and TWR.

**Step 4: Create CombinedPortfolioChart**

Recharts `AreaChart` showing all accounts stacked over time, using monthly snapshot data.

**Step 5: Verify it renders**

Run: `npm run dev`, navigate to `/dashboard`
Expected: Tab nav renders, overview shows placeholder data (or real data if DB has been seeded)

**Step 6: Commit and push**

```bash
git add -A
git commit -m "feat: dashboard layout with tab navigation and overview tab"
git push
```

---

## Task 11: Dashboard — Import Tab

**Files:**
- Create: `app/dashboard/import/page.tsx`
- Create: `app/dashboard/components/ImportDropZone.tsx`
- Create: `app/dashboard/components/ImportPreview.tsx`
- Create: `app/dashboard/components/ImportHistory.tsx`

**Step 1: Create ImportDropZone**

Client component with:
- Drag-and-drop area (accepts CSV, PDF)
- File picker button as fallback
- Multi-file support
- On file drop: call `/api/import?mode=preview` and show ImportPreview

**Step 2: Create ImportPreview**

Shows parsed results before committing:
- File name + detected source type
- Summary counts (transactions, securities, holdings, prices, snapshots)
- Expandable sections for each data type showing sample records
- "Import" and "Cancel" buttons

On "Import": call `/api/import?mode=commit` and refresh import history.

**Step 3: Create ImportHistory**

Server component showing all import batches from `import_batches` table:
- Date, filename, source type, record count
- "Undo" button per batch (calls API to delete batch records)

**Step 4: Verify the full import flow**

Drop a real IBKR CSV → see preview → confirm → see it in history → check DB.

**Step 5: Commit and push**

```bash
git add -A
git commit -m "feat: import tab with drag-and-drop, preview, and history"
git push
```

---

## Task 12: Dashboard — Accounts Tab

**Files:**
- Create: `app/dashboard/accounts/page.tsx`
- Create: `app/dashboard/components/AccountDetail.tsx`
- Create: `app/dashboard/components/HoldingsTable.tsx`
- Create: `app/dashboard/components/TransactionHistory.tsx`
- Create: `app/dashboard/components/EquityCurveChart.tsx`
- Create: `lib/queries/transactions.ts`
- Create: `lib/queries/holdings.ts`

**Step 1: Create per-account detail view**

Dropdown or sub-tabs for each account. Shows:
- Equity curve chart (monthly snapshots over time)
- Current holdings table (symbol, quantity, value, cost basis, gain/loss)
- Transaction history (filterable by type, date range, symbol)

**Step 2: Create query functions**

`getTransactionsByAccount`, `getHoldingsByAccount`, `getSnapshotsByAccount`

**Step 3: Commit and push**

```bash
git add -A
git commit -m "feat: accounts tab with detail views, holdings, transactions"
git push
```

---

## Task 13: Compute Engines (Daily Valuations + Tax Lots)

**Files:**
- Create: `lib/compute/daily-valuation.ts`
- Create: `lib/compute/tax-lots.ts`
- Create: `app/api/compute/valuations/route.ts`
- Create: `app/api/compute/tax-lots/route.ts`
- Create: `tests/compute/tax-lots.test.ts`
- Create: `tests/compute/daily-valuation.test.ts`

**Step 1: Write tests for tax lot computation**

FIFO matching: given a set of buys and sells, compute cost basis allocation correctly.

**Step 2: Implement tax lot computation**

Process all BUY transactions into tax lots, then match SELL transactions FIFO. Write results to `tax_lots` and `tax_lot_sales`.

**Step 3: Write tests for daily valuation**

Given holdings + prices, compute daily total value per account.

**Step 4: Implement daily valuation**

For each date with price data: sum(quantity * price) per account.

**Step 5: Create API routes**

POST `/api/compute/tax-lots` — recompute all tax lots
POST `/api/compute/valuations` — recompute daily valuations

**Step 6: Commit and push**

```bash
git add -A
git commit -m "feat: compute engines for tax lots (FIFO) and daily valuations"
git push
```

---

## Task 14: Dashboard — Tax Lots + Reconciliation Tabs

**Files:**
- Create: `app/dashboard/tax-lots/page.tsx`
- Create: `app/dashboard/reconciliation/page.tsx`
- Create: `app/dashboard/components/TaxLotSummary.tsx`
- Create: `app/dashboard/components/ReconciliationTable.tsx`
- Create: `lib/queries/tax-lots.ts`
- Create: `lib/queries/reconciliation.ts`

**Step 1: Tax Lots tab**

Shows per-security tax lot breakdown:
- Open lots (acquisition date, quantity, cost basis, current value, unrealized gain)
- Closed lots / sales (acquisition date, sale date, gain/loss, long-term vs short-term)
- Summary: total unrealized, total realized, by account

**Step 2: Reconciliation tab**

Shows statement checkpoints:
- Date, account, statement value, computed value, difference
- Add checkpoint form (enter values from your actual statements)

**Step 3: Commit and push**

```bash
git add -A
git commit -m "feat: tax lots and reconciliation dashboard tabs"
git push
```

---

## Task 15: Portfolio Chat (Claude-Powered Q&A)

**Files:**
- Create: `app/dashboard/chat/page.tsx`
- Create: `app/dashboard/components/ChatInterface.tsx`
- Create: `app/api/chat/route.ts`
- Create: `lib/queries/portfolio-summary.ts`

**Step 1: Create portfolio summary query**

Gathers key data for Claude context:
- Account values and allocations
- Top holdings by value
- Recent performance
- Recent transactions

**Step 2: Create chat API route**

Streaming endpoint that:
1. Gathers portfolio context from DB
2. Sends user question + context to Claude API
3. Streams response back

**Step 3: Create ChatInterface component**

Simple chat UI:
- Message history
- Input box
- Streaming response display

**Step 4: Commit and push**

```bash
git add -A
git commit -m "feat: portfolio chat with Claude-powered Q&A"
git push
```

---

## Task 16: Polish + Integration Testing

**Files:**
- Create: `app/dashboard/components/ErrorBoundary.tsx`
- Create: `tests/integration/full-import-flow.test.ts`
- Modify: various files for polish

**Step 1: Integration test**

Full cycle: create in-memory DB → import IBKR CSV fixture → import Vanguard holdings fixture → query dashboard data → verify everything connects.

**Step 2: Error boundary**

Wrap dashboard in error boundary that shows helpful messages instead of blank screens.

**Step 3: Loading states**

Add loading skeletons to all tabs.

**Step 4: Polish the Overview tab**

Ensure the combined chart looks good with real data after imports.

**Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

**Step 6: Commit and push**

```bash
git add -A
git commit -m "feat: integration tests, error boundaries, loading states"
git push
```

---

## Build Order Summary

| Task | Milestone | Depends On |
|------|-----------|------------|
| 1 | Project scaffold | — |
| 2 | Database + migrations | 1 |
| 3 | Query/mutation layers | 2 |
| 4 | Import types + detection | 3 |
| 5 | IBKR CSV parsers | 4 |
| 6 | Vanguard CSV parsers | 4 |
| 7 | Claude PDF parser | 4 |
| 8 | Import engine | 5, 6, 7 |
| 9 | Import API route | 8 |
| 10 | Dashboard layout + Overview | 3 |
| 11 | Import tab UI | 9, 10 |
| 12 | Accounts tab UI | 10 |
| 13 | Compute engines | 3 |
| 14 | Tax Lots + Reconciliation UI | 10, 13 |
| 15 | Portfolio Chat | 10 |
| 16 | Polish + integration tests | all |

Tasks 5, 6, 7 can be parallelized. Tasks 10, 11, 12 can overlap. Task 15 is independent of 13, 14.
