# Donation Tracking (R4) + In-Kind Transfer FMV Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Donations become a first-class, DAF-CSV-sourced ledger with tax-lot consumption, and in-kind transfer legs stop corrupting every flow-adjusted metric.

**Architecture:** A new `daf-contributions` import family writes `donations`; explicit user-confirmed `donation_leg_links` join donations to statement transfer legs (and demote routing-artifact legs out of flow math); `donation_lots` assignments drive a new donation-consumption event kind inside `computeTaxLots`'s chronological replay; flow readers gain an in-kind exclusion for cash stepping and an in-kind union for TWR/XIRR snapshot paths; a dry-run repair script fixes history; an Analysis "Giving" view surfaces it all.

**Tech Stack:** Next.js 16 App Router, better-sqlite3, Vitest, papaparse. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-17-donation-tracking-design.md` — the plan argues from the spec; executors read both. The spec's §14 records three Codex review rounds already folded in.

## Global Constraints

- Tests/scripts ALWAYS via `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run <path>` / `npx tsx <script>` — never bare `tsx`/`node`.
- TDD per task: write the failing test, watch it fail, implement, watch it pass, commit. Commit messages via `git commit -F <tmpfile>` (never inline `-m`).
- All DB functions take `db: Database.Database` as first param (DI). Reads in `lib/queries/`, writes in `lib/mutations/`.
- Route envelope: `{success:true,data}` / `{success:false,error}`. In-app routes take no cron auth. Client mutations go through `apiFetch` (eslint enforces).
- Every user-facing dollar/percent/share renders through `lib/privacy/components.tsx` (`<Money>`, `<Shares>`, `<Pct>`).
- Committed fixtures are SYNTHETIC — never real DAF rows, tickers, or values. Real files stay in `~/Downloads` / `data/` (gitignored).
- All dates `YYYY-MM-DD`; ET-anchor date derivation via `timeZone:"America/New_York"`.
- `npm run verify:changed` after each task; full `npx vitest run` + `npx next build` before final review.
- Never hardcode financial values in code; every valuation flows through `lib/valuation.ts::marketValue` or comes from the authoritative DAF row.

---

### Task 1: Migration 081 — donations, donation_leg_links, donation_lots

**Files:**
- Create: `lib/db/migrations/081_donations.sql`
- Test: `tests/db/migration-081-donations.test.ts`

**Interfaces:**
- Consumes: `runMigrations` from `@/lib/db/migrate` (existing).
- Produces: tables `donations`, `donation_leg_links`, `donation_lots` exactly as below; all later tasks depend on these column names.

- [ ] **Step 1: Write the failing test**

```ts
// tests/db/migration-081-donations.test.ts
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

function cols(db: Database.Database, table: string): string[] {
  return (db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[]).map((c) => c.name);
}

describe("migration 081 — donations", () => {
  it("creates donations, donation_leg_links, donation_lots with constraints and indexes", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);

    expect(cols(db, "donations")).toEqual(
      expect.arrayContaining([
        "id", "source_key", "import_batch_id", "kind", "security_id", "symbol_raw",
        "quantity", "fmv_usd", "unit_valuation", "created_date", "received_date",
        "completed_date", "reversed_date", "notes",
      ])
    );
    expect(cols(db, "donation_leg_links")).toEqual(
      expect.arrayContaining(["id", "donation_id", "transaction_id", "role", "created_at"])
    );
    expect(cols(db, "donation_lots")).toEqual(
      expect.arrayContaining(["id", "donation_id", "acquisition_transaction_id", "quantity", "created_at"])
    );

    // CHECK constraints reject bad rows
    const insertDonation = db.prepare(
      `INSERT INTO donations (source_key, kind, fmv_usd, received_date) VALUES (?, ?, ?, ?)`
    );
    expect(() => insertDonation.run("k1", "stock", -5, "2026-01-01")).toThrow(); // fmv_usd > 0
    expect(() => insertDonation.run("k2", "weird", 5, "2026-01-01")).toThrow(); // kind check
    insertDonation.run("k3", "cash", 5, "2026-01-01"); // valid

    // partial unique indexes: one 'out' + one 'routing_artifact' link per donation
    const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]).map((r) => r.name);
    expect(idx).toEqual(expect.arrayContaining(["idx_donation_out_link", "idx_donation_artifact_link", "idx_donations_received", "idx_donations_security"]));

    // FK integrity clean
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/db/migration-081-donations.test.ts`
Expected: FAIL (tables missing).

- [ ] **Step 3: Write the migration**

```sql
-- lib/db/migrations/081_donations.sql
-- R4 donation tracking (spec: docs/superpowers/specs/2026-08-17-donation-tracking-design.md §4).
-- donations rows come ONLY from the daf-contributions import; links/assignments
-- ONLY from explicit user confirmation or a reviewed repair --apply.

CREATE TABLE donations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_key TEXT UNIQUE NOT NULL,
  import_batch_id INTEGER,
  kind TEXT NOT NULL CHECK (kind IN ('stock','cash')),
  security_id INTEGER,
  symbol_raw TEXT,
  quantity REAL CHECK (quantity IS NULL OR quantity > 0),
  fmv_usd REAL NOT NULL CHECK (fmv_usd > 0),
  unit_valuation REAL CHECK (unit_valuation IS NULL OR unit_valuation > 0),
  created_date TEXT,
  received_date TEXT NOT NULL,
  completed_date TEXT,
  reversed_date TEXT,
  notes TEXT,
  FOREIGN KEY(import_batch_id) REFERENCES import_batches(id),
  FOREIGN KEY(security_id) REFERENCES securities(id)
);
CREATE INDEX idx_donations_received ON donations(received_date);
CREATE INDEX idx_donations_security ON donations(security_id);

CREATE TABLE donation_leg_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  donation_id INTEGER NOT NULL,
  transaction_id INTEGER NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('out','routing_artifact')),
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(donation_id) REFERENCES donations(id) ON DELETE CASCADE,
  FOREIGN KEY(transaction_id) REFERENCES transactions(id)
);
-- v1 pair model: exactly one flow-carrying leg and at most one artifact leg per donation.
CREATE UNIQUE INDEX idx_donation_out_link ON donation_leg_links(donation_id) WHERE role = 'out';
CREATE UNIQUE INDEX idx_donation_artifact_link ON donation_leg_links(donation_id) WHERE role = 'routing_artifact';

CREATE TABLE donation_lots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  donation_id INTEGER NOT NULL,
  acquisition_transaction_id INTEGER NOT NULL,
  quantity REAL NOT NULL CHECK (quantity > 0),
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(donation_id, acquisition_transaction_id),
  FOREIGN KEY(donation_id) REFERENCES donations(id) ON DELETE CASCADE,
  FOREIGN KEY(acquisition_transaction_id) REFERENCES transactions(id)
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/db/migration-081-donations.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

`git add lib/db/migrations/081_donations.sql tests/db/migration-081-donations.test.ts` then commit: `feat(donations): migration 081 — donations, leg links, lot assignments (#R4)`

---

### Task 2: Donations queries + core mutations (create, metadata upsert, reversal)

**Files:**
- Create: `lib/queries/donations.ts`, `lib/mutations/donations.ts`
- Test: `tests/mutations/donations.test.ts`

**Interfaces:**
- Consumes: Task 1 tables.
- Produces (later tasks call these EXACT signatures):

```ts
// lib/queries/donations.ts
export interface DonationRow {
  id: number; source_key: string; import_batch_id: number | null;
  kind: "stock" | "cash"; security_id: number | null; symbol_raw: string | null;
  quantity: number | null; fmv_usd: number; unit_valuation: number | null;
  created_date: string | null; received_date: string; completed_date: string | null;
  reversed_date: string | null; notes: string | null;
}
export function getDonations(db: Database.Database): DonationRow[];              // all, newest received first
export function getDonationBySourceKey(db: Database.Database, sourceKey: string): DonationRow | null;
export function getDonationsForYear(db: Database.Database, year: string): DonationRow[]; // received_date LIKE 'YYYY-%'

// lib/mutations/donations.ts
export interface NewDonation {
  sourceKey: string; kind: "stock" | "cash"; securityId: number | null; symbolRaw: string | null;
  quantity: number | null; fmvUsd: number; unitValuation: number | null;
  createdDate: string | null; receivedDate: string; completedDate: string | null; notes: string | null;
}
export function insertDonation(db: Database.Database, d: NewDonation, importBatchId: number | null): number; // returns id
/** Metadata-only upsert (spec §5): updates completed_date/unit_valuation/notes on an
 * existing source_key. Returns "updated" | "unchanged". Identity mismatch throws — the
 * caller (engine) surfaces it as a preview conflict, never writes. */
export function upsertDonationMetadata(db: Database.Database, d: NewDonation): "updated" | "unchanged";
export class DonationIdentityConflictError extends Error { constructor(public sourceKey: string, public field: string); }
/** Per-donation reversal (spec §7): sets reversed_date, deletes links (restoring
 * is_external_flow=1 on a routing_artifact leg first) and lot assignments.
 * Caller triggers recompute. Throws if donation missing. */
export function markDonationReversed(db: Database.Database, donationId: number, reversedDate: string): void;
```

- [ ] **Step 1: Write the failing tests** — in `tests/mutations/donations.test.ts`, using the `fresh()` in-memory idiom from `tests/queries/sessions.test.ts:16-25` (`new Database(":memory:")`, `foreign_keys = ON`, `runMigrations`). Cases:

```ts
// (abridged headers; write each as a full it() block)
// 1. insertDonation inserts a stock row and getDonationBySourceKey round-trips every field.
// 2. insertDonation with importBatchId null works (repair-path row).
// 3. upsertDonationMetadata fills completed_date on an existing row -> "updated";
//    a second identical call -> "unchanged"; import_batch_id is UNCHANGED (immutable ownership).
// 4. upsertDonationMetadata with a different quantity throws DonationIdentityConflictError naming "quantity".
// 5. markDonationReversed sets reversed_date, deletes donation_leg_links + donation_lots rows,
//    and restores is_external_flow=1 on the routing_artifact-linked transaction.
//    (Seed: one donation, one TRANSFER_OUT txn linked 'out', one TRANSFER_IN txn linked
//    'routing_artifact' with is_external_flow=0; after reversal the IN txn reads is_external_flow=1.)
// 6. getDonationsForYear("2026") returns only 2026-received rows, newest first.
```

Seed transactions with the raw-INSERT idiom (`INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, amount, is_external_flow, source_key) VALUES (...)`); migrations seed default accounts — reuse account id 1.

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/mutations/donations.test.ts` (module missing).

- [ ] **Step 3: Implement.** `lib/queries/donations.ts` is three prepared-statement one-liners. `lib/mutations/donations.ts`:

```ts
import type Database from "better-sqlite3";

export class DonationIdentityConflictError extends Error {
  constructor(public sourceKey: string, public field: string) {
    super(`donation ${sourceKey}: authoritative identity field '${field}' changed — refusing silent update`);
  }
}

const IDENTITY_FIELDS: [keyof NewDonation, string][] = [
  ["kind", "kind"], ["securityId", "security_id"], ["symbolRaw", "symbol_raw"],
  ["quantity", "quantity"], ["fmvUsd", "fmv_usd"], ["receivedDate", "received_date"],
];

export function insertDonation(db: Database.Database, d: NewDonation, importBatchId: number | null): number {
  const r = db.prepare(
    `INSERT INTO donations (source_key, import_batch_id, kind, security_id, symbol_raw, quantity,
       fmv_usd, unit_valuation, created_date, received_date, completed_date, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(d.sourceKey, importBatchId, d.kind, d.securityId, d.symbolRaw, d.quantity,
        d.fmvUsd, d.unitValuation, d.createdDate, d.receivedDate, d.completedDate, d.notes);
  return r.lastInsertRowid as number;
}

export function upsertDonationMetadata(db: Database.Database, d: NewDonation): "updated" | "unchanged" {
  const existing = db.prepare("SELECT * FROM donations WHERE source_key = ?").get(d.sourceKey) as Record<string, unknown> | undefined;
  if (!existing) throw new Error(`upsertDonationMetadata: no donation for source_key ${d.sourceKey}`);
  for (const [k, col] of IDENTITY_FIELDS) {
    const incoming = d[k] ?? null;
    if ((existing[col] ?? null) !== incoming) throw new DonationIdentityConflictError(d.sourceKey, col);
  }
  const r = db.prepare(
    `UPDATE donations SET completed_date = ?, unit_valuation = ?, notes = ?
     WHERE source_key = ?
       AND (COALESCE(completed_date,'') != COALESCE(?,'')
         OR COALESCE(unit_valuation,-1) != COALESCE(?,-1)
         OR COALESCE(notes,'') != COALESCE(?,''))`
  ).run(d.completedDate, d.unitValuation, d.notes, d.sourceKey, d.completedDate, d.unitValuation, d.notes);
  return r.changes > 0 ? "updated" : "unchanged";
}

export function markDonationReversed(db: Database.Database, donationId: number, reversedDate: string): void {
  const run = db.transaction(() => {
    const exists = db.prepare("SELECT id FROM donations WHERE id = ?").get(donationId);
    if (!exists) throw new Error(`markDonationReversed: donation ${donationId} not found`);
    // Restore flow flag on any demoted artifact leg BEFORE dropping the link.
    db.prepare(
      `UPDATE transactions SET is_external_flow = 1
       WHERE id IN (SELECT transaction_id FROM donation_leg_links WHERE donation_id = ? AND role = 'routing_artifact')`
    ).run(donationId);
    db.prepare("DELETE FROM donation_leg_links WHERE donation_id = ?").run(donationId);
    db.prepare("DELETE FROM donation_lots WHERE donation_id = ?").run(donationId);
    db.prepare("UPDATE donations SET reversed_date = ? WHERE id = ?").run(reversedDate, donationId);
  });
  run();
}
```

- [ ] **Step 4: Run to verify pass**, then **Step 5: Commit** — `feat(donations): queries + core mutations (insert, metadata upsert, reversal)`

---

### Task 3: Link + lot-assignment mutations with reject-not-clamp invariants

**Files:**
- Create: `lib/mutations/donation-links.ts`
- Test: `tests/mutations/donation-links.test.ts`

**Interfaces:**
- Consumes: Task 1 tables; Task 2 `DonationRow`.
- Produces:

```ts
// lib/mutations/donation-links.ts
export class DonationLinkError extends Error {}   // every invariant rejection; message is domain-language

/** Confirms a donation<->legs pair (spec §7). outTransactionId required; artifactTransactionId
 * optional (pair-form donations). Validates atomically (spec §4 invariants); on success writes
 * links, stamps the OUT leg amount if amountForOutLeg != null, and demotes the artifact leg
 * (is_external_flow=0 + note suffix). Caller triggers recompute. */
export function linkDonationLegs(db: Database.Database, args: {
  donationId: number;
  outTransactionId: number;
  artifactTransactionId?: number | null;
  amountForOutLeg?: number | null;
}): void;

/** Removes links for a donation, restoring is_external_flow=1 (+ stripping the note suffix)
 * on a demoted artifact leg. Does NOT touch amounts (a stamped FMV is a data correction that
 * stands on its own evidence). */
export function unlinkDonationLegs(db: Database.Database, donationId: number): void;

/** Replaces the donation's lot assignments atomically after validating spec §4 invariants
 * (a)-(f). Empty array = clear. */
export function assignDonationLots(db: Database.Database, donationId: number,
  assignments: { acquisitionTransactionId: number; quantity: number }[]): void;

export const ARTIFACT_NOTE_SUFFIX = " [routing artifact of DAF donation; excluded from flows]";
```

**Invariant checks in `linkDonationLegs` (each with its own test):** donation exists, is `kind='stock'`, has non-null `security_id`, not reversed; OUT txn exists, `type='TRANSFER_OUT'`, same `security_id`; artifact txn (when given) exists, `type='TRANSFER_IN'`, same `security_id`, same `account_id` as the OUT leg, same `trade_date`, and quantities zero-net (`|out.qty - in.qty| < 1e-9`); neither txn already linked (schema UNIQUE also enforces). **In `assignDonationLots`:** donation has a confirmed `out` link; each acquisition txn is a lot-creating type (`LOWER(type) IN ('buy','reinvestment','buy_to_open','sell_to_open','transfer_in')`) on the same security AND same account as the out leg; `trade_date < donation out-leg trade_date`; per-lot assigned ≤ that lot's `quantity_acquired` minus quantity already sold before the donation date (compute from `tax_lot_sales` joined via `tax_lots.acquisition_transaction_id`, `sale_date < outLeg.trade_date`); Σ assigned ≤ `donations.quantity` (± 1e-9).

- [ ] **Step 1: Write failing tests** — one `it()` per invariant rejection asserting `DonationLinkError` with a message containing the offending concept (e.g. `/different security/`), plus happy paths: link with artifact (asserts `is_external_flow` flips 0 and note appended; amount stamped when passed), unlink (flag restored, note suffix stripped, amounts untouched), assignment replace + clear.
- [ ] **Step 2: Verify failure.** **Step 3: Implement** (single `db.transaction` per mutation; SELECT-validate then write; every rejection `throw new DonationLinkError("...")`).
- [ ] **Step 4: Verify pass.** **Step 5: Commit** — `feat(donations): leg-link + lot-assignment mutations with reject-not-clamp invariants`

---
### Task 4: DAF parser + format detection + parsed-record family

**Files:**
- Create: `lib/import/parsers/daf-contributions.ts`, `tests/fixtures/daf-contributions-sample.csv`
- Modify: `lib/import/types.ts` (SourceType union at :1-11; `ParsedImportResult` at :103-115), `lib/import/detect.ts` (new branch before the `return "unknown"` at :77), `lib/import/engine.ts:161-196` (parseImport dispatch case)
- Test: `tests/import/daf-contributions-parser.test.ts`

**Interfaces:**
- Consumes: `getSecurityBySymbolCI` (created here beside `getSecurityBySymbol` in `lib/queries/securities.ts` — `WHERE UPPER(symbol) = ?` with upper-cased param, per the `lib/securities/resolve-underlying.ts:18` precedent). NOTE: the parser itself stays db-free; symbol resolution happens in the ENGINE commit/preview (Task 5) so `parseImport` keeps its pure signature.
- Produces:

```ts
// lib/import/types.ts additions
export type SourceType = /* existing 10 */ | "daf-contributions";
export interface ParsedDonation {
  sourceKey: string;                 // daf:contribution:{received_date}:{symbol|USD}:{qty|amount}:{createdAtRaw}
  kind: "stock" | "cash";
  symbolRaw: string | null;          // null for cash
  quantity: number | null;
  fmvUsd: number;
  unitValuation: number | null;
  createdDate: string | null;        // ET date of "created at"
  receivedDate: string;              // ET date of "received at" — the tax date
  completedDate: string | null;
  createdAtRaw: string | null;       // verbatim provider timestamp (identity component)
}
// ParsedImportResult gains OPTIONAL family (mirrors factors?; avoids touching 10 return sites):
//   donations?: ParsedDonation[];
// lib/import/parsers/daf-contributions.ts
export function parseDafContributions(content: string, filename: string): ParsedImportResult;
export function etDateFromUtcTimestamp(ts: string): string | null;  // exported for tests
```

- [ ] **Step 1: Write the synthetic fixture** (`tests/fixtures/daf-contributions-sample.csv`) — same shape as the real export, entirely fake values:

```csv
type,frequency,amount,currency,USD amount,currency valuation,created at,received at,completed at

  Stock,One time,10.0,FAKE,1234.5,123.45,2026-03-01 20:00:00 +0000,2026-03-02 13:00:00 +0000,2026-03-03 17:00:00 +0000
  Stock,One time,5.0,ZZZZ,500.0,,2026-04-10 01:30:00 +0000,2026-04-10 13:00:00 +0000,
  Bank transfer,One time,2500.0,USD,2500.0,1,2026-05-01 12:00:00 +0000,2026-05-02 05:00:00 +0000,2026-05-02 05:00:00 +0000
  Crypto,One time,1.0,BTC,999.0,,2026-06-01 12:00:00 +0000,2026-06-02 13:00:00 +0000,
```

(Fourth row exercises the unknown-`type` skip-with-warning path. Second row: blank `currency valuation` and blank `completed at`. The `2026-04-10 01:30:00 +0000` created-at is 2026-04-09 in ET — pins the ET-anchor conversion.)

- [ ] **Step 2: Write failing tests** in `tests/import/daf-contributions-parser.test.ts`:

```ts
// 1. detectSourceType(fixtureContent, "contributions-2026.csv") === "daf-contributions"
// 2. parseDafContributions: 3 donations (Crypto row skipped -> 1 warning mentioning "Crypto");
//    row1: kind stock, symbolRaw "FAKE", quantity 10, fmvUsd 1234.5, unitValuation 123.45,
//          receivedDate "2026-03-02", completedDate "2026-03-03", createdDate "2026-03-01";
//    row2: unitValuation null, completedDate null;
//    row3: kind cash, symbolRaw null, quantity null, fmvUsd 2500.
// 3. ET anchoring: etDateFromUtcTimestamp("2026-04-10 01:30:00 +0000") === "2026-04-09".
// 4. source keys: row1 === "daf:contribution:2026-03-02:FAKE:10:2026-03-01 20:00:00 +0000";
//    cash row uses :USD:2500:...; keys are unique across the file.
// 5. A row missing "created at" whose (date,symbol,qty) collides with another row is returned
//    with sourceKey null-created marker and a warning (engine blocks it later) — assert the
//    warning text contains "identity".
// 6. parseImport dispatch: parseImport(fixtureContent, "contributions-2026.csv") resolves with
//    sourceType "daf-contributions" and donations.length === 3.
```

- [ ] **Step 3: Verify failure**, **Step 4: Implement**:

detect branch (`lib/import/detect.ts`, before `return "unknown"`):
```ts
  // DAF yearly contribution export: distinctive 9-column header.
  if (firstLine.startsWith("type,frequency,amount,currency,USD amount,currency valuation")) {
    return "daf-contributions";
  }
```

Parser skeleton (copy `canonical-csv.ts` structure — Papa.parse with `header: true, skipEmptyLines: true`, trim every cell since rows carry leading whitespace):
```ts
export function etDateFromUtcTimestamp(ts: string): string | null {
  const m = ts.trim().match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) \+0000$/);
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2]}Z`);
  if (Number.isNaN(d.getTime())) return null;
  // en-CA gives YYYY-MM-DD directly
  return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}
```
Per row: `type` "Stock" → stock (symbolRaw = `currency` col upper-trimmed, quantity = parseStrictNumber(`amount`), fmvUsd = parseStrictNumber(`USD amount`), unitValuation = blank → null); "Bank transfer" → cash; anything else → warning + skip. Reject rows with non-positive fmvUsd (warning + skip). sourceKey = `` `daf:contribution:${receivedDate}:${symbolOrUSD}:${qtyOrAmount}:${createdAtRaw ?? ""}` ``; when createdAtRaw is empty AND the bare key collides in-file, keep the row but push the "identity" warning (engine blocks at commit, Task 5). Return object literal with `donations`, empty arrays for the other families, `errors`/`warnings`.

`parseImport` dispatch case: `case "daf-contributions": return parseDafContributions(text, filename);`

- [ ] **Step 5: Verify pass**, **Step 6: Commit** — `feat(import): daf-contributions parser + detection + ParsedDonation family`

---

### Task 5: Engine commit/preview for donations + transfer-leg conflict guard

**Files:**
- Modify: `lib/import/engine.ts` (commit step after transactions ~:379; `CommitResult` at :201-214; summary at :700-716), `lib/import/validate.ts` (`SkippedRow.category` union :126-131 + a donations validation loop), `app/api/import/route.ts:81-107` (preview payload)
- Create: `lib/import/donations-commit.ts` (the logic lives here; engine calls it — keeps engine.ts churn small)
- Test: `tests/import/daf-import-commit.test.ts`, `tests/import/transfer-conflict-guard.test.ts`

**Interfaces:**
- Consumes: Task 2 mutations (`insertDonation`, `upsertDonationMetadata`, `DonationIdentityConflictError`), Task 4 `ParsedDonation`, `getSecurityBySymbolCI`.
- Produces:

```ts
// lib/import/donations-commit.ts
export interface DonationCommitOutcome {
  newDonations: number;
  updatedDonations: number;
  identityConflicts: { sourceKey: string; field: string }[];
  blockedNoIdentity: string[];        // rows blocked for missing created-at identity
  unresolvedSymbols: string[];        // imported with security_id NULL
}
export function commitDonations(db: Database.Database, donations: ParsedDonation[], batchId: number): DonationCommitOutcome;

/** Cumulative-file reversal check (spec §5): donations already in the DB for the years
 * covered by this file that are ABSENT from the file. Pure read — used by preview AND
 * surfaced as commit warnings. */
export function findAbsentPriorDonations(db: Database.Database, donations: ParsedDonation[]): DonationRow[];

/** Transfer-leg conflict guard (spec §7): incoming in-kind TRANSFER legs whose
 * (account, date, security, type, quantity) matches an existing row with a DIFFERENT amount.
 * Returns the conflicting incoming rows' indices; engine skips them at commit and the
 * preview surfaces them. */
export function findTransferAmountConflicts(db: Database.Database, txns: ParsedTransaction[],
  accountIdFor: (t: ParsedTransaction) => number | null, securityIdFor: (t: ParsedTransaction) => number | null): number[];
```

- [ ] **Step 1: Failing tests.** `daf-import-commit.test.ts`: full pipeline `parseImport(fixture)` → `commitImport(db, parsed)` asserts: batch row exists with summary containing `"3 donations"`; re-commit of the same file → 0 new, 0 updated, batch 2 summary contains `"0 donations"` or duplicates note; a second fixture variant where row2 gained a `completed at` → `updatedDonations === 1` and the DB row's completed_date filled while `import_batch_id` still points at batch 1; a variant changing row1's quantity → identityConflicts length 1, DB unchanged; unresolved symbol ("ZZZZ" absent from securities) imports with `security_id NULL` and appears in `unresolvedSymbols`; `findAbsentPriorDonations` flags a DB donation for 2026 missing from a truncated file. `transfer-conflict-guard.test.ts`: seed an existing in-kind TRANSFER_OUT (qty 50, amount 0); canonical-csv parse of a re-authored row (same account/date/security/type/qty, amount 4550) → commit skips it (transactions count unchanged) and `CommitResult.warnings` carries a conflict message; same row with SAME amount → normal dedupe no-op; a DIFFERENT-qty row inserts normally.
- [ ] **Step 2: Verify failure.** **Step 3: Implement.** `commitDonations`: loop rows; blocked-no-identity check first; `getDonationBySourceKey` → exists ? try `upsertDonationMetadata` catch `DonationIdentityConflictError` → conflicts list : `insertDonation` with CI-resolved security. Engine wiring: inside the `db.transaction`, after corporate actions step, `if (parsed.donations?.length) { outcome = commitDonations(...) }`; `CommitResult` gains `newDonations`, `updatedDonations` (numbers, default 0); `recordCount += newDonations`; summary array gains the two donation clauses; conflict guard runs where transactions insert (step 3, :337-379): compute conflict indices ONCE before the insert loop, skip + warn. Validate: `SkippedRow.category` gains `"donation"`; a donations loop rejects rows with `fmvUsd <= 0` or missing `receivedDate` (belt-and-braces after parser). Preview (`app/api/import/route.ts`): add `donations: { count, newCount, updatedCount, identityConflicts, absentPriorRows, unresolvedSymbols }` — computed via the same pure helpers against the live db (route already holds db), following the `corporateActions: {count, sample}` precedent at :96-102.
- [ ] **Step 4: Verify pass.** **Step 5: Commit** — `feat(import): donations commit/preview + in-kind transfer amount-conflict guard`

---

### Task 6: Undo refusal + donations undo + recovery v2 (relation-based)

**Files:**
- Modify: `lib/mutations/import-batches.ts:39-59` (deleteImportBatch order), `lib/import/engine.ts:826` area (undoImport pre-check), `app/api/import/route.ts:260-310` (handleUndoRequest refusal branch, BEFORE recordUndo so refusals don't burn rate-limit), `lib/import/recovery.ts` (MANIFEST_VERSION 2, relations capture + remap)
- Test: `tests/import/donations-undo-recovery.test.ts`

**Interfaces:**
- Consumes: Tasks 1-3 tables/mutations.
- Produces:

```ts
// lib/import/recovery.ts additions
export interface DonationRelationRow { /* full donation_leg_links or donation_lots row minus id, plus: */
  transaction_source_key: string;      // stable identity of the referenced transaction
  donation_source_key: string;         // stable identity of the parent donation
}
// RecoveryPayload gains: donations: Row[]; donationLinkRelations: DonationRelationRow[]; donationLotRelations: DonationRelationRow[];
// lib/mutations/import-batches.ts
export function batchDonationReferences(db: Database.Database, batchId: number): { links: number; lots: number };
```

Behavior to implement, each TDD'd:

1. **Refusal:** `undoImport` (and `handleUndoRequest` step-2 path) first checks whether the batch's TRANSACTIONS are referenced by `donation_leg_links.transaction_id` or `donation_lots.acquisition_transaction_id`; if so → throw/`{status: 409, body: {success:false, error: "N donation links / M lot assignments reference this batch's transactions — unlink or unassign them in Analysis › Giving first."}}`. Refusal happens BEFORE `recordUndo`.
2. **Donations-batch undo:** `deleteImportBatch` gains, BEFORE `DELETE FROM transactions`: restore `is_external_flow=1` + strip `ARTIFACT_NOTE_SUFFIX` on artifact legs whose links cascade with this batch's donations, then `DELETE FROM donations WHERE import_batch_id = ?` (links/lots cascade via FK).
3. **Recovery v2:** `MANIFEST_VERSION = 2`; capture adds the batch's `donations` rows (stripRowId) plus relation rows for their links/lots serialized WITH `transaction_source_key` (JOIN transactions) and `donation_source_key`; `readRecoveryManifest` accepts v1 files (donation fields default empty). Restore order: existing tables → donations (OR IGNORE by source_key) → links/lots with ids remapped via `SELECT id FROM transactions WHERE source_key = ?` / `SELECT id FROM donations WHERE source_key = ?`; a missing referenced source_key → skip that relation row with a restore warning (cross-batch transaction not present), never a throw.

- [ ] **Step 1: Failing tests** — (a) undo of a transactions batch with a live link → 409-shaped error, nothing deleted; (b) undo of a daf batch: donations gone, artifact leg's `is_external_flow` back to 1, note suffix stripped; (c) recovery round-trip: commit daf batch + link + assign (link references a transaction from a DIFFERENT batch), `undoImportWithRecovery`, `restoreImportBatch` → donations back, link/lot rows re-pointed at the (new-id) rows, `PRAGMA foreign_key_check` clean; (d) a v1 manifest (hand-built minimal) still restores.
- [ ] **Step 2-4: fail → implement → pass.** **Step 5: Commit** — `feat(import): donation-aware undo refusal + batch undo + recovery manifest v2 with source-key remap`

---

### Task 7: Flow-reader exclusion + TWR/XIRR in-kind union

**Files:**
- Modify: `lib/compute/flow-adjusted.ts:43-71` (opts param), `lib/compute/daily-valuation.ts:325-349` (pass excludeInKind + rewrite the reuse-contract comment), `lib/compute/twr.ts` (:296-340 per-account branches; :573-590 portfolio branch + carried-deposits :538-549), `lib/compute/xirr.ts` (:364-424 per-account; :554-567 portfolio; totals accumulation)
- Test: extend `tests/compute/transfer-flow-sign.test.ts`; create `tests/compute/inkind-flow-union.test.ts`

**Interfaces:**

```ts
// flow-adjusted.ts — 5th positional param, all existing call sites unchanged:
export function fetchNetFlowsByDate(db, accountIds, startDate, endDate,
  opts: { excludeInKind?: boolean } = {}): { date: string; net: number }[];
// twr.ts + xirr.ts internal helper (duplicated per file is acceptable; or export from flow-adjusted.ts):
export const IN_KIND_LEG_SQL = "type IN ('TRANSFER_IN','TRANSFER_OUT') AND security_id IS NOT NULL";
```

**Union rule (spec §6.5, exploration caveat #2):** in-kind flows are NEVER in `monthly_snapshots.deposits_withdrawals`, and the transaction-fallback branches already include them. Therefore: augment ONLY the snapshot-preferred paths, and in XIRR — whose snapshot preference is RANGE-wide — add the in-kind flows per-month for the whole range whenever the snapshot branch is taken. Never touch the fallback branches.

- [ ] **Step 1: Failing tests.**
  - `fetchNetFlowsByDate(..., {excludeInKind: true})` drops an in-kind OUT (security_id set) but keeps a DEPOSIT on the same date; default call unchanged (existing 4 cases still pass untouched).
  - Daily valuation: an in-kind OUT with FMV does NOT step `daily_valuations.cash_balance` (seed anchor snapshots two months apart, one in-kind OUT between, assert cash flat) while a WITHDRAWAL still steps.
  - TWR per-account: month with snapshot `deposits_withdrawals = -10_000` (cash) AND an in-kind OUT amount 5_000 → monthly return uses BOTH flows (compute expected Modified Dietz by hand in the test); month with snapshot flows and NO in-kind → unchanged; fallback month (NULL d_w) with in-kind → included exactly once.
  - XIRR per-account: range where month A has snapshot flow and month B (no snapshot flow) has an in-kind OUT → the OUT appears as a positive cash-flow event (money out of portfolio = investor-side inflow sign per existing convention — copy the sign the WITHDRAWAL path uses) AND `totalWithdrawn` includes it; assert with a hand-computed XIRR bracket, not an exact float.
  - Portfolio TWR: existing case 3 (pair wash) still passes; new case — snapshot-covered month + unpaired in-kind OUT → return matches hand-computed Dietz; carried-deposits month skip: in-kind flow in a skipped month is carried like cash deposits (assert no vanish: two-month carry scenario).
- [ ] **Step 2: Verify failure.** **Step 3: Implement.** `fetchNetFlowsByDate`: `const inKindFilter = opts.excludeInKind ? \`AND NOT (${IN_KIND_LEG_SQL})\` : ""`. daily-valuation: pass `{excludeInKind: true}` + rewrite the :325-345 comment to state the new contract. TWR per-account: build once per account `inKindFlowStmt` = same shape as `cashFlowStmt` (:203-210) plus `AND ${IN_KIND_LEG_SQL}`; in both snapshot branches (:300, :321) append its day-weighted rows to `weightedFlows`. Portfolio: same augmentation inside the `effectiveDeposits !== 0` branch using a grouped in-kind statement mirroring `allFlowStmt` (:463-470); extend the carried-deposits accumulator to carry in-kind sums alongside. XIRR: in the `snapshotFlows.length > 0` branches (per-account :364, portfolio :554), fetch in-kind rows for the whole range (`externalFlowStmt` shape + `AND ${IN_KIND_LEG_SQL}`) and push them as dated cash-flow events with the same sign convention as the transaction-fallback branch; accumulate `totalInvested`/`totalWithdrawn` identically (donated FMV counts as withdrawn — spec §6.5 refinement).
- [ ] **Step 4: Verify pass (including the 4 pre-existing transfer-flow-sign cases).** **Step 5: Commit** — `feat(flows): excludeInKind cash-stepping guard + in-kind FMV union in TWR/XIRR snapshot paths`

---
### Task 8: Reconciliation module (pure)

**Files:**
- Create: `lib/compute/donation-reconciliation.ts`
- Test: `tests/compute/donation-reconciliation.test.ts`

**Interfaces:**
- Consumes: Task 2 `DonationRow`, `getDonations`; reads `transactions` + `donation_leg_links` directly.
- Produces (Task 11 repair + Task 12 API + Task 13 UI all consume this):

```ts
export interface TransferLegRow {
  id: number; account_id: number; security_id: number; trade_date: string;
  type: "TRANSFER_IN" | "TRANSFER_OUT"; quantity: number; amount: number | null;
  is_external_flow: number; symbol: string; linked_role: "out" | "routing_artifact" | null;
}
export interface ReconciliationReport {
  suggestedMatches: { donation: DonationRow; outLeg: TransferLegRow; artifactLeg: TransferLegRow | null }[];
  attempts: { leg: TransferLegRow; state: "in-transit" | "bounced"; returnLeg: TransferLegRow | null }[];
  legsMissing: DonationRow[];                 // stock donations, unreversed, with no linked or suggestible legs
  duplicateSuspects: TransferLegRow[][];      // groups sharing (account,date,security,qty,type), differing amounts
  unmatchedPairs: { date: string; symbol: string; quantity: number }[];  // zero-netting, no donation — informational
}
export function reconcileDonations(db: Database.Database): ReconciliationReport;
/** ±N business days (weekends only; holidays ignored — documented approximation). Exported for tests. */
export function withinBusinessDays(a: string, b: string, n: number): boolean;
```

**Rules (spec §7, all already user-ratified):** net residuals per (account, trade_date, security) EXCLUDING `routing_artifact`-linked legs; suggestions only for unreversed, USD-security, resolved-symbol stock donations with no existing `out` link; match = equal quantity within ±5 business days of `received_date`; ambiguity (2+ candidates either direction) → NOT suggested, folded into `legsMissing` with the ambiguity noted via a `notes` clone field — simpler: return ambiguous donations in `legsMissing` and the legs in `attempts` as `in-transit` (the UI copy explains); pair-donation = zero-netting same-day pair matching a donation exactly → suggestion carries both legs; bounced = unmatched OUT residual + later matching IN (same security+qty, any later date, itself unlinked).

- [ ] **Step 1: Failing tests** — table-driven over a seeded in-memory DB: exact-date match; +4 business-day match (crosses a weekend — pins `withinBusinessDays`); +6 business days → no match; pair-donation suggestion (both legs returned); already-linked donation → no suggestion; reversed donation → excluded; bounced sequence (OUT day X, IN day X+40) → `bounced` with returnLeg; lone OUT → `in-transit`; duplicate-suspect group (two OUTs same key-tuple, amounts 0 vs 4550); rebooking pair with no donation → `unmatchedPairs`; ambiguous two-donation case → no suggestion.
- [ ] **Step 2-4: fail → implement → pass.** Implementation is one pure function over three prepared queries (legs+links+symbol join, donations, existing links); keep every rule a small named helper so the test names read as the spec.
- [ ] **Step 5: Commit** — `feat(donations): reconciliation report (suggestions, attempts, bounces, duplicate suspects)`

---

### Task 9: Tax-lot engine — donation consumption in the chronological replay

**Files:**
- Modify: `lib/compute/tax-lots.ts` (:305-326 event loop → sorted-union refactor; consumption closure; result counters), `app/api/import/route.ts:170-180` (widen the replay-warning gate: report when `replayWarnings.length > 0` regardless of `hadCorporateActions`)
- Test: `tests/compute/tax-lots-donations.test.ts` (copy helpers wholesale from `tests/compute/tax-lots-splits.test.ts:6-56`)

**Interfaces:**
- Consumes: Tasks 1-3 tables (reads `donation_leg_links` role `out` + `donation_lots`, both via one JOIN query at recompute start; skips reversed donations).
- Produces: `TaxLotComputeResult` gains `donationsConsumed: number` (count of lots reduced); replayWarnings channel reused for defensive clamps.

**The refactor (exploration caveat #3):** replace the two-stream pointer merge with a single merged event array:

```ts
type ReplayEvent =
  | { kind: 0; date: string; id: number; sell: SellRow }          // sells first
  | { kind: 1; date: string; id: number; donation: DonationConsumption } // then donations
  | { kind: 2; date: string; id: number; split: SplitEvent };     // splits last (preserves the strict-'<' end-of-day rule)
// sort: (a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.kind - b.kind || a.id - b.id
```

`DonationConsumption` = `{ donationId, outLegDate, assignments: { acquisitionTransactionId, quantity }[] }` built from the JOIN (`donation_leg_links dl JOIN transactions t ON t.id = dl.transaction_id JOIN donation_lots ol ON ol.donation_id = dl.donation_id JOIN donations d ON d.id = dl.donation_id WHERE dl.role='out' AND d.reversed_date IS NULL`), dated by the OUT leg's `trade_date`. `applyDonationConsumption` closure: for each assignment, `SELECT id, quantity_remaining FROM tax_lots WHERE acquisition_transaction_id = ?`; missing lot or `quantity_remaining < assigned` → push replayWarning (`"donation {id}: lot from txn {id} has {remaining} < assigned {qty} — clamped"`) and clamp; else `UPDATE tax_lots SET quantity_remaining = quantity_remaining - ? WHERE id = ?`. **No `tax_lot_sales` row.** RECONCILE_CLOSE pass (:328-443) runs after — consumed lots correctly stop being orphans, no change there. `reconcile_delta` needs no change (its `preOpen` reads `quantity_remaining` live — ordering does the work).

- [ ] **Step 1: Failing tests** (each seeds via the splits-test helpers):
  1. Basic: buy 100 → donate 40 (link + assign 40 from that lot) → `quantity_remaining` 60, `donationsConsumed` 1, zero `tax_lot_sales` rows, `totalRealizedGain` 0.
  2. Partial multi-lot: two lots 50+50, assign 30+20 → remainders 20/30.
  3. Same-day ordering: sell 30 and donate 40 on the SAME date from a 100-lot with FIFO — sell consumes first (remaining 70), then donation (remaining 30).
  4. Split before donation: buy 100, 2:1 split (lot → 200), donate 40 post-split units → remaining 160.
  5. Split ON the donation date: sell + donation process pre-split (kind order 0,1 < 2), then the split doubles the remainder — assert exact numbers.
  6. Split after donation: donate 40 from 100, later 2:1 split → remaining (100-40)*2 = 120 and `reconcile_delta` NULL (delta math saw post-consumption preOpen).
  7. Defensive clamp: assign 80 but 30 already sold earlier → warning pushed, remaining 0, suite still completes.
  8. Reversed donation: linked+assigned then `markDonationReversed` → recompute consumes nothing.
  9. Bounce inertness: an unlinked TRANSFER_OUT (no donation row) changes nothing.
  10. RECONCILE_CLOSE interaction: holdings row says 60 held, lot 100 with 40 donated-consumed → NO reconcile close synthesized (60 == 60).
- [ ] **Step 2-4: fail → refactor loop → implement closure → pass** (run `tests/compute/tax-lots*.test.ts` — ALL existing lot suites must stay green; the refactor is behavior-preserving for kind 0/2 by construction of the sort).
- [ ] **Step 5: Commit** — `feat(tax-lots): donation-consumption events in chronological replay (sells→donations→splits)`

---

### Task 10: Repair script `repair-inkind-transfer-fmv.ts`

**Files:**
- Create: `scripts/repair-inkind-transfer-fmv.ts`
- Test: `tests/scripts/repair-inkind-transfer-fmv.test.ts`

**Interfaces:**
- Consumes: Task 8 `reconcileDonations`, Task 3 `linkDonationLegs`, `lib/valuation.ts::marketValue`, `backupDatabase` pattern from `scripts/repair-missing-external-flows.ts:321-334` (copy verbatim, new filename prefix `pre-inkind-fmv-repair-`).
- Produces (pure, exported for tests; CLI wires them):

```ts
export type InkindCandidateClass = "pair-donation" | "fmv-stamp" | "legs-missing" | "anomaly";
export interface InkindCandidate {
  cls: InkindCandidateClass;
  legId?: number; donationId?: number; artifactLegId?: number;
  proposedAmount?: number;             // present only on writable classes
  reason: string;                      // one printable line
}
export function findInkindCandidates(db: Database.Database): InkindCandidate[];
/** Holdings-delta gate for pair-donations: the containing statement month's holdings rows
 * for (account,security) drop by >= donation quantity across the month boundary. */
export function holdingsDeltaConfirms(db: Database.Database, accountId: number, securityId: number,
  legDate: string, quantity: number): boolean;
export function applyInkindRepair(db: Database.Database, candidates: InkindCandidate[]): { applied: number; skipped: number };
```

**Class rules (spec §8, all ratified):**
- `pair-donation` (writable): reconciliation suggestion with BOTH legs + `holdingsDeltaConfirms` → `linkDonationLegs` with `amountForOutLeg` (same-day exact match → `fmv_usd`; else exact-LEG-date price via `marketValue(qty, close, security_type, multiplier, 1)` — exact-date `prices` row only, USD security only, no corporate action between; unpriceable → downgrade to `anomaly`).
- `fmv-stamp` (writable): unlinked in-kind leg, `amount = 0` — same valuation precedence; UPDATE `transactions.amount` only, source_key untouched.
- `legs-missing` (report): stock donations with no legs — print guidance (import the covering statement / author via canonical CSV), never INSERT.
- `anomaly` (report): duplicate-suspects, unpriceable, ambiguous, failed holdings-delta.
CLI: dry-run default (readonly open, exactly the `repair-missing-external-flows.ts:409-433` shape), `--apply` → backup → apply → trigger `computeTaxLots` + `computeDailyValuations` + print flow-dates gained (before/after `fetchNetFlowsByDate` count over full history). Header doc = runbook (usage, idempotency: re-run finds zero writable candidates).

- [ ] **Step 1: Failing tests** — pure-function coverage: pair-donation happy path (asserts link rows, amount stamped, artifact demoted); same-day exact → fmv_usd chosen; 1-day gap → leg-date price chosen; no exact-date price → anomaly; non-USD security → anomaly; corporate action between → anomaly; holdings delta absent → anomaly; fmv-stamp on a lone journal leg via price road; idempotence (second `findInkindCandidates` after apply → no writable rows); legs-missing donation reported not inserted. **Plus the spec §11 metric before/after case:** a fixture portfolio with a pair-form donation month — `buildFlowAdjustedIndex` (or portfolio TWR) computed BEFORE repair shows the fake-loss day; AFTER `applyInkindRepair` the day carries a flow, the return observation normalizes, and `fetchNetFlowsByDate` gains exactly one date.
- [ ] **Step 2-4: fail → implement → pass.** **Step 5: Commit** — `feat(repair): in-kind transfer FMV repair (pair-donation demotion + stamping, dry-run default)`

---

### Task 11: Doc/guide lockstep + conventions

**Files:**
- Modify: `app/dashboard/components/CanonicalCsvGuide.tsx:45` + example rows at :53, `docs/canonical-csv-guide.md:68` + example at :81, `.claude/skills/import-monthly-statements/SKILL.md:67`, `docs/reference/conventions-detail.md` (transfer-leg convention block at :151-155 + flow block at :404-406), `CLAUDE.md` (one Invariants bullet)
- Test: none (docs) — but `npx next build` must stay clean (the TSX guide).

- [ ] **Step 1:** All three amount-instruction copies change to the same sentence: *"Set `amount` to the transfer-date market value (positive; the row type carries direction — the flow readers sign it). Leave `price` empty for journal/donation legs (a priced TRANSFER_IN creates a tax lot — ACATS only). Transcribe both legs of a printed pair verbatim; deciding whether an IN leg is a DAF routing artifact happens in Analysis › Giving, never at authoring time."* Update the guide example rows to carry a market-value amount. SKILL.md row becomes: `| Share journal / gift (no cash) | TRANSFER_IN / TRANSFER_OUT | amount = transfer-date market value (positive) | one row per journal line, never merged |`.
- [ ] **Step 2:** `conventions-detail.md`: extend the §404 flow block with the in-kind FMV convention, the `excludeInKind` cash-stepping exception, and the TWR/XIRR snapshot-path union; extend :151-155 with the donation-link/artifact concepts. `CLAUDE.md` Invariants gains one line: *"In-kind TRANSFER legs carry transfer-date FMV in `amount` (positive; type carries direction); routing-artifact legs are demoted via `donation_leg_links`, never deleted; cash stepping excludes in-kind legs (`excludeInKind`)."*
- [ ] **Step 3: Commit** — `docs: in-kind FMV convention lockstep (guide ×3, conventions, CLAUDE.md)`

---
### Task 12: API routes (Giving data + five mutations)

**Files:**
- Create: `lib/queries/giving-view.ts`, `app/api/donations/route.ts` (GET), `app/api/donations/[id]/links/route.ts` (POST confirm, DELETE unlink), `app/api/donations/[id]/lots/route.ts` (POST assign), `app/api/donations/[id]/reverse/route.ts` (POST), `app/api/donations/[id]/resolve-security/route.ts` (POST)
- Test: `tests/api/donations-routes.test.ts` (drive the exported handler logic with an in-memory db, like `tests/api/pin.test.ts` does)

**Interfaces:**
- Consumes: Tasks 2, 3, 8, 9 (`getDonations`, `linkDonationLegs`/`unlinkDonationLegs`, `assignDonationLots`, `markDonationReversed`, `reconcileDonations`, `computeTaxLots`).
- Produces:

```ts
// lib/queries/giving-view.ts — the single assembly the GET route and the server page share
export interface GivingYear {
  year: string;
  totalGiven: number; stockGiven: number; cashGiven: number;
  gainAvoided: number | null;          // null when any stock donation in the year lacks assignments
  donations: GivingDonation[];
}
export interface GivingDonation {
  donation: DonationRow;
  accountName: string | null;          // via the out-leg link
  basis: number | null; gainAvoided: number | null;
  longTermQuantity: number | null; shortTermQuantity: number | null;
  status: "completed" | "received" | "reversed";
  needsLots: boolean; linked: boolean; symbolResolved: boolean;
}
export function getGivingView(db: Database.Database): { years: GivingYear[]; reconciliation: ReconciliationReport };
```

Basis/gain math per assigned lot (from `tax_lots` via `acquisition_transaction_id`): `basis = Σ assigned_qty × (cost_basis / quantity_acquired)`; `gainAvoided = donation.fmv_usd − basis`; long-term if `acquisition_date ≤ received_date − 365 days`. Unassigned or unresolved → nulls + `needsLots`.

**Route shapes (copy the two patterns from `app/api/research/articles/[id]/unfilter/route.ts` and `app/api/compute/tax-lots/route.ts`):** every mutation route parses the id, calls the mutation in try/catch — `DonationLinkError`/`DonationIdentityConflictError` → 400 with the domain message; success → run `computeTaxLots(db)` in its OWN try/catch and return `{success:true, data:{saved:true, recomputed:boolean, recomputeError?:string}}` (spec §10 recompute-failure feedback; never a 500 for a saved write). `links` POST body: `{outTransactionId, artifactTransactionId?, amountForOutLeg?}`. `lots` POST body: `{assignments:[{acquisitionTransactionId, quantity}]}`. `reverse` POST body: `{reversedDate}` (must be YYYY-MM-DD; 400 otherwise). `resolve-security` POST body: `{securityId}` — validates the security exists and is USD, sets `donations.security_id` (only when currently NULL → else 409 "already resolved").

- [ ] **Step 1: Failing tests** — one describe per route: happy path, invariant-violation → 400 carrying the domain message, recompute-failure path (monkeypatch `computeTaxLots` import via vitest `vi.mock` to throw → `recomputed:false` + `recomputeError`), resolve-security on an already-resolved donation → 409. Plus `getGivingView`: seeded year with one assigned + one pending donation → `gainAvoided: null` at year level, per-row values correct, LT/ST split correct across the 365-day boundary.
- [ ] **Step 2-4: fail → implement → pass.** **Step 5: Commit** — `feat(api): giving view assembly + donation link/lot/reverse/resolve routes`

---

### Task 13: Giving view UI

**Files:**
- Modify: `lib/analysis/view-param.ts:15-20,:41-53` (+ its test `tests/lib/analysis-view-param.test.ts`), `app/dashboard/analysis/page.tsx` (new early-return branch beside :124-151), `app/dashboard/components/nav-tabs.ts:18-24`, `app/dashboard/components/AnalysisViewToggle.tsx:9-15`, `app/dashboard/components/TransactionHistory.tsx:11-20` (TYPE_STYLES gains `TRANSFER_IN: "bg-blue/20 text-blue"`, `TRANSFER_OUT: "bg-gold/20 text-gold-ink"`)
- Create: `app/dashboard/components/giving/GivingView.tsx` (server), `app/dashboard/components/giving/GivingYearSection.tsx`, `app/dashboard/components/giving/ReconciliationStrip.tsx` (client), `app/dashboard/components/giving/LotAssignmentDrawer.tsx` (client)
- Test: extend `tests/lib/analysis-view-param.test.ts` (`"giving"` case + default fallthrough unchanged)

**Structure:**
- `analysis/page.tsx` branch: `if (resolved.view === "giving") return <div className="space-y-6 md:space-y-0"><AnalysisViewToggle currentView="giving" scope={params.scope} /><GivingView /></div>;` — account-agnostic: `GivingView` takes NO scope prop (spec §10); wrap its data call in the try/catch-rethrow idiom from `analysis/page.tsx:205-217`.
- `GivingView` (server): calls `getGivingView(db)`, renders year sections + `<ReconciliationStrip report={...} />`. Cash rows in a visually separated sub-block per year captioned "Cash gifts — bank→DAF, not portfolio activity". Every figure via `<Money>`/`<Shares>`; status chips via `<Chip tone="up|info|warn">` (`completed`/`received`/`pending lots`), `tone="down"` for `reversed`.
- `ReconciliationStrip` (client): suggested matches with a Confirm button (`apiFetch` POST `/api/donations/{id}/links`), attempts (`in-transit`/`bounced` chips), legs-missing guidance, duplicate suspects, unmatched pairs (collapsed, informational). Honest-feedback rules: check `res.ok` AND `data.success`; when `data.data.recomputed === false` show "Saved — lot recompute failed: {recomputeError}. Retry from the drawer."; revert optimistic state on failure.
- `LotAssignmentDrawer` (client): copy the drawer skeleton from `app/dashboard/components/analysis/MacroThemeReceiptDrawer.tsx` (fixed overlay, Escape handler, backdrop click, `stopPropagation`). Lists open lots as of the donation date (served by a small `GET /api/donations/[id]/lots` handler added to the Task 12 route file: lot rows + suggested highest-gain-LT preselection flags); checkboxes + qty inputs; "Suggest highest-gain long-term" button preselects client-side; Save posts assignments. No hover-only affordances (touch tap-trap rule).
- Unresolved-symbol rows render the raw symbol + a "Resolve…" button → inline search against `GET /api/search?q=…&type=security` → POST resolve-security.

- [ ] **Step 1:** view-param failing test (`"giving"` → `{view:"giving", mode:"classification"}`), fail → implement param+nav+toggle → pass.
- [ ] **Step 2:** Build components (server-first; client islands only where mutations live). Run `npx next build` — clean.
- [ ] **Step 3:** Manual dev-server smoke: `/dashboard/analysis?view=giving` renders empty-state (`<EmptySection>` when no donations — never a silent null).
- [ ] **Step 4: Commit** — `feat(giving): Analysis Giving view (years, reconciliation strip, lot drawer)`

---

### Task 14: Integration verification + close-out

**Files:**
- Modify: `docs/plans/TODO.md` (close TODO:64 in place; update [R4] entry to point at the spec + shipped state)
- No new code — this is the evidence task.

- [ ] **Step 1:** `npm run verify:changed` → green. Full suite: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run` → report exact counts (baseline 5,390 + 9 todo; every new test adds on top). `npx next build` → clean.
- [ ] **Step 2:** Authenticated browser E2E against the dev server (`npm run dev`, then the agent-browser road — mint a session via `scripts/mint-qa-session.ts` against the DEV database, install cookies exactly as `qa/run-qa.sh` does): import the SYNTHETIC fixture through the Import tab (preview shows donation counts), confirm, open Analysis › Giving, confirm a suggested match, assign lots via the drawer, toggle privacy mode (values mask), undo the batch from Import (donations vanish, artifact restored), CSRF-negative check (raw fetch POST without the header → 401). Capture screenshots to a gitignored evidence dir per `docs/reference/verification-loop.md`.
- [ ] **Step 3:** Dry-run the repair against the REAL db (read-only — safe): `PATH=... npx tsx scripts/repair-inkind-transfer-fmv.ts` and paste the candidate table into the session for user review. **USER-RUN (never the executor):** `--apply`, followed by importing the real `contributions-*.csv` files via the UI and confirming the eight pair-donations. These two steps are listed for the user at session close, exactly like the QA data companions.
- [ ] **Step 4:** Update `docs/plans/TODO.md`: TODO:64 → closed-this-session block; [R4] entry → "shipped 2026-08-17 (spec + plan links); residual: user-run repair --apply + real DAF import".
- [ ] **Step 5: Commit** — `docs(todo): R4 donation tracking shipped; in-kind FMV fix verified`

---

## Execution notes

- Tasks 1→3 are strictly sequential (schema → core → invariants). Tasks 4→6 sequential (types → engine → undo). Task 7 is independent of 2-6 (can run any time after 1). Task 8 needs 2; Task 9 needs 3+8 concepts but only tables from 1-3; Task 10 needs 3+8; Tasks 12-13 need everything before them. Recommended order is simply 1..14.
- The executor for each task sees ONLY that task — the **Interfaces: Produces** blocks are the contract; do not rename exported symbols.
- Per-task commits on main (this repo's convention for SDD); push held until the user's final review.
- If any task's tests reveal the spec missed something, STOP and surface it — do not improvise schema changes mid-task.

