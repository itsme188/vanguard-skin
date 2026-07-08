# Earnings Intelligence (implied move + print history) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the two classic earnings-prep lines — options-implied expected move (ATM straddle, IV fallback) and past-8-quarter surprise/reaction history — to the preview email scoreboard and the earnings-day cockpit, snapshot-carried to the Worker cloud fallback.

**Architecture:** Approach A from the spec (`docs/superpowers/specs/2026-07-08-earnings-intelligence-design.md`): two cache tables (migration 065), pure compute engines with DI-injected fetchers, a TTL-guarded orchestrator (`ensureIntelForEvents`), and three thin read-only consumers (email composer, cockpit route, R2 snapshot → Worker). Fresh straddle at preview-compose time; everything best-effort — intel failure can never block a send.

**Tech Stack:** TypeScript 5 / Next.js 16, better-sqlite3 (`:memory:` + `runMigrations` in tests), Vitest, IBKR Web API OAuth 1.0a (existing `lib/ibkr/*`), Alpha Vantage `EARNINGS` (existing key), Yahoo daily chart endpoint.

## Global Constraints

- **Read the spec first**: `docs/superpowers/specs/2026-07-08-earnings-intelligence-design.md`. It is the contract.
- **Data integrity — probe before constants**: no IBKR endpoint param or field code may be committed unverified; Task 1's live probe output is the source of truth (house rule; the R1b probe caught the field-31 `C`-prefix).
- **Percent units**: `implied_move_pct`, `surprise_pct`, `post_print_move_pct` all store PERCENT (4.8 = ±4.8%), matching `security_betas.residual_std` precedent.
- **All DB functions take `db: Database.Database`** (queries in `lib/queries/`, mutations in `lib/mutations/`); dates `YYYY-MM-DD`; timestamps compared via `datetime()` on both sides or parsed with `parseStoredTimestamp` (`lib/format.ts`).
- **Best-effort everywhere**: `ensureIntelForEvents` never throws to a caller; email send paths (claim mutex, marker dance) untouched.
- **No privacy masking**: implied move / history / expiries are public market data (plain formatters, per the privacy-market-data rule).
- **AI-test-mocking rule**: no test may depend on live keys — AV/Yahoo/IBKR are DI-injected in every test.
- **Never define a component inside a component body** (EarningsCockpit Lane remount trap).
- **Worker renders read-only from snapshot** — zero new Worker subrequests.
- Run `npx vitest run <path>` per task; full suite + `cd workers/cron && npx vitest run` + `npx tsc --noEmit` in the final task. Commit per task with descriptive messages.

## File map

| File | Role |
|---|---|
| `scripts/probe-ibkr-option-chain.ts` (new) | Live probe: secdef/strikes + secdef/info param shapes, option bid/ask field codes |
| `lib/db/migrations/065_earnings_intel.sql` (new) | `earnings_report_history` + `earnings_intel` tables |
| `lib/mutations/earnings-intel.ts` (new) | `upsertEarningsIntel`, `replaceReportHistory` |
| `lib/queries/earnings-intel.ts` (new) | `getIntelForEvents`, `getReportHistoryForFamily`, `isHistoryStale`, `decorateCockpitIntel` |
| `lib/earnings/implied-move.ts` (new, PURE zero-import) | straddle/IV math, expiry + ATM pickers, mid computation, guards |
| `lib/quotes/yahoo-daily.ts` (new) | `fetchYahooDailyCloses(symbol, fromDate, toDate, fetchImpl?)` |
| `lib/earnings/report-history.ts` (new) | AV fetch + post-print move computation + summarize + refresh orchestration |
| `lib/ibkr/option-chain.ts` (new) | `resolveAtmContracts` via secdef/strikes + secdef/info |
| `lib/ibkr/market-data.ts` (modify) | BID/ASK snapshot fields (probe-verified), `ParsedQuote.bid/ask` |
| `lib/earnings/intel.ts` (new) | `ensureIntelForEvents` orchestrator, 30-min TTL |
| `lib/digest/send-earnings-email.ts` (modify) | scoreboard rows, `renderPastPrintsBlock`, prompt injection, forceFresh call, recap echo |
| `app/api/earnings/email-content/route.ts` (modify) | pass cached intel to `renderHeadlineTable` |
| `lib/queries/earnings-cockpit.ts` (modify) | `CockpitRow.intel` field (type only; population via decorate) |
| `app/api/earnings/cockpit/route.ts` (modify) | ensure + decorate before responding |
| `app/dashboard/today/EarningsCockpit.tsx` (modify) | `impl ±X% · hist ±Y%` line |
| `scripts/snapshot-state-to-r2.ts` (modify) | schemaVersion 9: `earningsIntel` + `earningsHistory` |
| `workers/cron/src/state.ts` + `workers/cron/src/fallback-earnings.ts` (modify) | snapshot types + read-only rendering with "as of" |

---

### Task 1: Live probe — IBKR option-chain endpoints + option bid/ask field codes

**Files:**
- Create: `scripts/probe-ibkr-option-chain.ts`

**Interfaces:**
- Produces: a `PROBE RESULTS (YYYY-MM-DD)` comment block at the top of the script recording (a) working `secdef/strikes` + `secdef/info` param shapes, (b) verified bid/ask field codes (expected `84`/`86` — NOT trusted until probed), (c) whether option bid/ask values carry `C`/`H`-style prefixes. Tasks 5 depends on this block.

- [ ] **Step 1: Write the probe script**

```typescript
/**
 * scripts/probe-ibkr-option-chain.ts
 *
 * Live probe for the earnings-intelligence straddle road. Run with TWS-off or
 * on (Web API is independent). Requires the IBKR OAuth config dir.
 *
 *   npx tsx scripts/probe-ibkr-option-chain.ts [SYMBOL]
 *
 * Probes, in order, printing RAW JSON for each:
 *   1. /iserver/secdef/strikes  — strikes for the front option month
 *   2. /iserver/secdef/info     — option conids + maturityDates for the ATM strike
 *   3. /iserver/marketdata/snapshot on the resolved call+put conids with
 *      candidate fields 31,84,85,86,88 — to pin which codes are bid/ask and
 *      whether values carry prefix markers like field 31's C/H.
 *
 * PROBE RESULTS (fill in after running — Task 5 constants come from here):
 *   - strikes params: <pending>
 *   - info params: <pending>
 *   - bid field: <pending>   ask field: <pending>
 *   - prefix markers on option bid/ask/last: <pending>
 */
import Database from "better-sqlite3";
import path from "path";
import { loadIbkrConfig } from "../lib/ibkr/config";
import { openSession } from "../lib/ibkr/web-api";
import { signedRequest } from "../lib/ibkr/oauth-client";

async function main() {
  const symbol = (process.argv[2] ?? "AAPL").toUpperCase();
  const cfg = loadIbkrConfig();
  if (!cfg) throw new Error("IBKR OAuth config not found");
  const db = new Database(path.join(process.cwd(), "data", "vanguard.db"), { readonly: true });
  const row = db
    .prepare("SELECT ib_con_id AS conid FROM securities WHERE UPPER(symbol) = ? AND ib_con_id IS NOT NULL")
    .get(symbol) as { conid: number } | undefined;
  db.close();
  if (!row) throw new Error(`No ib_con_id for ${symbol}`);
  const conid = row.conid;

  const lstResp = await openSession(cfg);
  const lst = typeof lstResp === "string" ? lstResp : (lstResp as { lst: string }).lst;

  // Front month in IBKR MMMYY form, e.g. "JUL26".
  const now = new Date();
  const month = now
    .toLocaleDateString("en-US", { month: "short", timeZone: "America/New_York" })
    .toUpperCase() + String(now.getFullYear()).slice(2);

  console.log(`── strikes (conid=${conid}, month=${month}) ──`);
  const strikesResp = await signedRequest(cfg, lst, "GET", "/iserver/secdef/strikes", {
    conid: String(conid), sectype: "OPT", month, exchange: "SMART",
  });
  const strikes = await strikesResp.json();
  console.log(JSON.stringify(strikes, null, 2).slice(0, 2000));

  const callStrikes: number[] = strikes?.call ?? [];
  const mid = callStrikes[Math.floor(callStrikes.length / 2)];
  console.log(`── info (strike=${mid}, right=C then P) ──`);
  const optionConids: number[] = [];
  for (const right of ["C", "P"]) {
    const infoResp = await signedRequest(cfg, lst, "GET", "/iserver/secdef/info", {
      conid: String(conid), sectype: "OPT", month, strike: String(mid), right, exchange: "SMART",
    });
    const info = await infoResp.json();
    console.log(right, JSON.stringify(info, null, 2).slice(0, 2000));
    const first = Array.isArray(info) ? info[0] : null;
    if (first?.conid) optionConids.push(Number(first.conid));
  }

  console.log(`── snapshot on option conids ${optionConids.join(",")} ──`);
  const fields = "31,84,85,86,88";
  const path_ = `/iserver/marketdata/snapshot?conids=${optionConids.join(",")}&fields=${fields}`;
  for (let i = 0; i < 3; i++) {
    const snapResp = await signedRequest(cfg, lst, "GET", path_, {});
    console.log(`poll ${i + 1}:`, JSON.stringify(await snapResp.json(), null, 2));
    await new Promise((r) => setTimeout(r, 1500));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
```

Note: if `signedRequest`'s query-param signature doesn't accept a query object for the snapshot path (it's built inline elsewhere), match the call style used by `lib/ibkr/market-data.ts::getMarketDataSnapshot` — path-embedded query, empty `query` object. Adjust until the probe RUNS; the script is a tool, not product code.

- [ ] **Step 2: Run it live**

Run: `npx tsx scripts/probe-ibkr-option-chain.ts AAPL`
Expected: three sections of raw JSON. If `openSession`'s return shape differs, fix the script (check `lib/ibkr/refresh.ts` for the working call pattern) and re-run.

- [ ] **Step 3: Record results in the header comment**

Fill the `PROBE RESULTS` block with the working param shapes, the verified bid/ask codes, and prefix behavior. This block is Task 5's source of truth.

- [ ] **Step 4: Commit**

```bash
git add scripts/probe-ibkr-option-chain.ts
git commit -m "chore(earnings-intel): live probe for IBKR option chain + bid/ask field codes"
```

---

### Task 2: Migration 065 + queries + mutations

**Files:**
- Create: `lib/db/migrations/065_earnings_intel.sql`
- Create: `lib/mutations/earnings-intel.ts`
- Create: `lib/queries/earnings-intel.ts`
- Test: `tests/queries/earnings-intel.test.ts`

**Interfaces:**
- Produces:
  - `upsertEarningsIntel(db, row: { eventId: number; impliedMovePct: number | null; impliedMethod: "straddle" | "iv_approx" | null; expiryUsed: string | null; straddleMid: number | null; spot: number | null; computedAt: string })`
  - `replaceReportHistory(db, symbol: string, rows: ReportHistoryRow[])` — transactional upsert + prune to newest 12 by `reported_date`
  - `ReportHistoryRow = { reportedDate: string; fiscalDateEnding: string | null; epsActual: number | null; epsEstimate: number | null; surprisePct: number | null; reportTime: "pre-market" | "post-market" | null; postPrintMovePct: number | null }`
  - `getIntelForEvents(db, eventIds: number[]): Map<number, EarningsIntelRow>` where `EarningsIntelRow = { eventId; impliedMovePct; impliedMethod; expiryUsed; straddleMid; spot; computedAt }`
  - `getReportHistoryForFamily(db, symbol: string, limit = 8): ReportHistoryRow[]` — newest-first, family-aware via `issuerSiblings`
  - `isHistoryStale(db, symbol: string): boolean` — true when no rows OR `MAX(fetched_at)` (family-aware) older than 70 days (parse via `parseStoredTimestamp` from `@/lib/format`)
  - `decorateCockpitIntel(db, payload)` — defined in Task 8 (placeholder export NOT created here)

- [ ] **Step 1: Write failing tests**

```typescript
// tests/queries/earnings-intel.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertEarningsIntel, replaceReportHistory } from "@/lib/mutations/earnings-intel";
import { getIntelForEvents, getReportHistoryForFamily, isHistoryStale } from "@/lib/queries/earnings-intel";

let db: Database.Database;

function seedEvent(): number {
  return db.prepare(
    `INSERT INTO calendar_events (source, source_key, event_type, event_date, week_of, title)
     VALUES ('finnhub', 'finnhub:TER:2026-07-14', 'earnings', '2026-07-14', '2026-07-13', 'TER earnings')`
  ).run().lastInsertRowid as number;
}

const HIST = (over: Partial<Parameters<typeof replaceReportHistory>[2][number]> = {}) => ({
  reportedDate: "2026-04-22", fiscalDateEnding: "2026-03-31",
  epsActual: 1.42, epsEstimate: 1.35, surprisePct: 5.2,
  reportTime: "post-market" as const, postPrintMovePct: 4.1, ...over,
});

beforeEach(() => { db = new Database(":memory:"); runMigrations(db); });

describe("earnings_intel cache", () => {
  it("upserts and reads intel per event", () => {
    const id = seedEvent();
    upsertEarningsIntel(db, { eventId: id, impliedMovePct: 4.8, impliedMethod: "straddle",
      expiryUsed: "2026-07-18", straddleMid: 6.2, spot: 129.1, computedAt: "2026-07-14 14:05:00" });
    upsertEarningsIntel(db, { eventId: id, impliedMovePct: 5.1, impliedMethod: "straddle",
      expiryUsed: "2026-07-18", straddleMid: 6.6, spot: 129.4, computedAt: "2026-07-14 14:35:00" });
    const map = getIntelForEvents(db, [id]);
    expect(map.get(id)?.impliedMovePct).toBe(5.1); // second upsert wins
  });

  it("cascades away when the calendar event is deleted", () => {
    const id = seedEvent();
    upsertEarningsIntel(db, { eventId: id, impliedMovePct: 4.8, impliedMethod: "straddle",
      expiryUsed: "2026-07-18", straddleMid: 6.2, spot: 129.1, computedAt: "2026-07-14 14:05:00" });
    db.prepare("DELETE FROM calendar_events WHERE id = ?").run(id);
    expect(getIntelForEvents(db, [id]).size).toBe(0);
  });
});

describe("earnings_report_history", () => {
  it("replace upserts, prunes to newest 12, reads newest-first", () => {
    const rows = Array.from({ length: 14 }, (_, i) =>
      HIST({ reportedDate: `2023-${String((i % 12) + 1).padStart(2, "0")}-15`, fiscalDateEnding: null }));
    // make dates unique + ordered: 2023-01-15 .. 2024-02-15
    rows.forEach((r, i) => { const y = 2023 + Math.floor(i / 12); r.reportedDate = `${y}-${String((i % 12) + 1).padStart(2, "0")}-15`; });
    replaceReportHistory(db, "TER", rows);
    const kept = db.prepare("SELECT COUNT(*) AS n FROM earnings_report_history WHERE symbol='TER'").get() as { n: number };
    expect(kept.n).toBe(12);
    const read = getReportHistoryForFamily(db, "TER", 8);
    expect(read).toHaveLength(8);
    expect(read[0].reportedDate > read[1].reportedDate).toBe(true); // newest first
  });

  it("getReportHistoryForFamily walks issuer siblings (GOOG ↔ GOOGL)", () => {
    replaceReportHistory(db, "GOOGL", [HIST()]);
    expect(getReportHistoryForFamily(db, "GOOG")).toHaveLength(1);
  });

  it("isHistoryStale: no rows → stale; fresh rows → not stale; old fetched_at → stale", () => {
    expect(isHistoryStale(db, "TER")).toBe(true);
    replaceReportHistory(db, "TER", [HIST()]);
    expect(isHistoryStale(db, "TER")).toBe(false);
    db.prepare("UPDATE earnings_report_history SET fetched_at = '2026-01-01 00:00:00' WHERE symbol='TER'").run();
    expect(isHistoryStale(db, "TER")).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `npx vitest run tests/queries/earnings-intel.test.ts`
Expected: FAIL (migration file / modules don't exist).

- [ ] **Step 3: Write the migration**

```sql
-- lib/db/migrations/065_earnings_intel.sql
-- Earnings intelligence tier (audit §4C #9/#10).
-- Spec: docs/superpowers/specs/2026-07-08-earnings-intelligence-design.md

CREATE TABLE earnings_report_history (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol              TEXT NOT NULL,
  reported_date       TEXT NOT NULL,
  fiscal_date_ending  TEXT,
  eps_actual          REAL,
  eps_estimate        REAL,
  surprise_pct        REAL,
  report_time         TEXT,
  post_print_move_pct REAL,
  source              TEXT NOT NULL DEFAULT 'alphavantage',
  fetched_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(symbol, reported_date)
);
CREATE INDEX idx_earnings_report_history_symbol ON earnings_report_history(symbol);

CREATE TABLE earnings_intel (
  event_id         INTEGER PRIMARY KEY REFERENCES calendar_events(id) ON DELETE CASCADE,
  implied_move_pct REAL,
  implied_method   TEXT,
  expiry_used      TEXT,
  straddle_mid     REAL,
  spot             REAL,
  computed_at      TEXT NOT NULL
);
```

- [ ] **Step 4: Write mutations**

```typescript
// lib/mutations/earnings-intel.ts
import type Database from "better-sqlite3";

export interface EarningsIntelUpsert {
  eventId: number;
  impliedMovePct: number | null;
  impliedMethod: "straddle" | "iv_approx" | null;
  expiryUsed: string | null;
  straddleMid: number | null;
  spot: number | null;
  computedAt: string;
}

export interface ReportHistoryRow {
  reportedDate: string;
  fiscalDateEnding: string | null;
  epsActual: number | null;
  epsEstimate: number | null;
  surprisePct: number | null;
  reportTime: "pre-market" | "post-market" | null;
  postPrintMovePct: number | null;
}

export function upsertEarningsIntel(db: Database.Database, row: EarningsIntelUpsert): void {
  db.prepare(
    `INSERT INTO earnings_intel (event_id, implied_move_pct, implied_method, expiry_used, straddle_mid, spot, computed_at)
     VALUES (@eventId, @impliedMovePct, @impliedMethod, @expiryUsed, @straddleMid, @spot, @computedAt)
     ON CONFLICT(event_id) DO UPDATE SET
       implied_move_pct = excluded.implied_move_pct,
       implied_method   = excluded.implied_method,
       expiry_used      = excluded.expiry_used,
       straddle_mid     = excluded.straddle_mid,
       spot             = excluded.spot,
       computed_at      = excluded.computed_at`
  ).run(row);
}

const KEEP_QUARTERS = 12;

export function replaceReportHistory(
  db: Database.Database,
  symbol: string,
  rows: ReportHistoryRow[],
): void {
  const sym = symbol.toUpperCase();
  const upsert = db.prepare(
    `INSERT INTO earnings_report_history
       (symbol, reported_date, fiscal_date_ending, eps_actual, eps_estimate, surprise_pct, report_time, post_print_move_pct, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(symbol, reported_date) DO UPDATE SET
       fiscal_date_ending = excluded.fiscal_date_ending,
       eps_actual = excluded.eps_actual,
       eps_estimate = excluded.eps_estimate,
       surprise_pct = excluded.surprise_pct,
       report_time = excluded.report_time,
       post_print_move_pct = excluded.post_print_move_pct,
       fetched_at = excluded.fetched_at`
  );
  const prune = db.prepare(
    `DELETE FROM earnings_report_history
     WHERE symbol = ? AND reported_date NOT IN (
       SELECT reported_date FROM earnings_report_history
       WHERE symbol = ? ORDER BY reported_date DESC LIMIT ${KEEP_QUARTERS})`
  );
  db.transaction(() => {
    for (const r of rows) {
      upsert.run(sym, r.reportedDate, r.fiscalDateEnding, r.epsActual, r.epsEstimate,
        r.surprisePct, r.reportTime, r.postPrintMovePct);
    }
    prune.run(sym, sym);
  })();
}
```

- [ ] **Step 5: Write queries**

```typescript
// lib/queries/earnings-intel.ts
import type Database from "better-sqlite3";
import { issuerSiblings } from "@/lib/securities/issuer-family";
import { parseStoredTimestamp } from "@/lib/format";
import type { ReportHistoryRow } from "@/lib/mutations/earnings-intel";

export interface EarningsIntelRow {
  eventId: number;
  impliedMovePct: number | null;
  impliedMethod: "straddle" | "iv_approx" | null;
  expiryUsed: string | null;
  straddleMid: number | null;
  spot: number | null;
  computedAt: string;
}

const HISTORY_STALE_DAYS = 70;

export function getIntelForEvents(db: Database.Database, eventIds: number[]): Map<number, EarningsIntelRow> {
  const out = new Map<number, EarningsIntelRow>();
  if (eventIds.length === 0) return out;
  const placeholders = eventIds.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT event_id AS eventId, implied_move_pct AS impliedMovePct, implied_method AS impliedMethod,
            expiry_used AS expiryUsed, straddle_mid AS straddleMid, spot, computed_at AS computedAt
     FROM earnings_intel WHERE event_id IN (${placeholders})`
  ).all(...eventIds) as EarningsIntelRow[];
  for (const r of rows) out.set(r.eventId, r);
  return out;
}

function familyPlaceholders(symbol: string): { list: string; syms: string[] } {
  const syms = issuerSiblings(symbol).map((s) => s.toUpperCase());
  return { list: syms.map(() => "?").join(","), syms };
}

export function getReportHistoryForFamily(
  db: Database.Database,
  symbol: string,
  limit = 8,
): ReportHistoryRow[] {
  const { list, syms } = familyPlaceholders(symbol);
  return db.prepare(
    `SELECT reported_date AS reportedDate, fiscal_date_ending AS fiscalDateEnding,
            eps_actual AS epsActual, eps_estimate AS epsEstimate, surprise_pct AS surprisePct,
            report_time AS reportTime, post_print_move_pct AS postPrintMovePct
     FROM earnings_report_history
     WHERE symbol IN (${list})
     ORDER BY reported_date DESC LIMIT ?`
  ).all(...syms, limit) as ReportHistoryRow[];
}

export function isHistoryStale(db: Database.Database, symbol: string): boolean {
  const { list, syms } = familyPlaceholders(symbol);
  const row = db.prepare(
    `SELECT MAX(fetched_at) AS latest FROM earnings_report_history WHERE symbol IN (${list})`
  ).get(...syms) as { latest: string | null };
  if (!row.latest) return true;
  const ageMs = Date.now() - parseStoredTimestamp(row.latest).getTime();
  return ageMs > HISTORY_STALE_DAYS * 24 * 60 * 60 * 1000;
}
```

- [ ] **Step 6: Run tests — verify they pass**

Run: `npx vitest run tests/queries/earnings-intel.test.ts`
Expected: PASS. If `parseStoredTimestamp` has a different name/signature, check `lib/format.ts` and adapt (it exists — added 2026-06-05).

- [ ] **Step 7: Commit**

```bash
git add lib/db/migrations/065_earnings_intel.sql lib/mutations/earnings-intel.ts lib/queries/earnings-intel.ts tests/queries/earnings-intel.test.ts
git commit -m "feat(earnings-intel): migration 065 + intel/history cache queries and mutations"
```

---

### Task 3: Pure implied-move engine

**Files:**
- Create: `lib/earnings/implied-move.ts` (ZERO imports — `plausibility.ts` pattern)
- Test: `tests/earnings/implied-move.test.ts`

**Interfaces:**
- Produces:
  - `straddleImpliedMovePct(callMid: number | null, putMid: number | null, spot: number | null): number | null`
  - `ivApproxMovePct(iv: number | null, dteDays: number | null): number | null` (iv is a FRACTION, e.g. 0.43)
  - `pickPostPrintExpiry(expirations: string[], eventDate: string, eventTime: "BMO" | "AMC" | null): string | null`
  - `pickAtmStrike(strikes: number[], spot: number): number | null`
  - `computeMid(bid: number | null, ask: number | null, last: number | null): number | null`
  - `defaultExpiryFriday(eventDate: string): string` — first Friday ≥ eventDate (IV-road DTE fallback)
  - `IMPLIED_MOVE_CORRUPT_CEILING_PCT = 60`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/earnings/implied-move.test.ts
import { describe, it, expect } from "vitest";
import {
  straddleImpliedMovePct, ivApproxMovePct, pickPostPrintExpiry,
  pickAtmStrike, computeMid, defaultExpiryFriday, IMPLIED_MOVE_CORRUPT_CEILING_PCT,
} from "@/lib/earnings/implied-move";

describe("straddleImpliedMovePct", () => {
  it("computes (call+put)/spot as percent", () => {
    expect(straddleImpliedMovePct(3.2, 3.0, 129.1)).toBeCloseTo(4.802, 2);
  });
  it("nulls on missing/non-positive inputs", () => {
    expect(straddleImpliedMovePct(null, 3.0, 129.1)).toBeNull();
    expect(straddleImpliedMovePct(3.2, 3.0, 0)).toBeNull();
    expect(straddleImpliedMovePct(3.2, 3.0, null)).toBeNull();
  });
});

describe("ivApproxMovePct", () => {
  it("iv × sqrt(dte/365) as percent", () => {
    expect(ivApproxMovePct(0.43, 4)).toBeCloseTo(0.43 * Math.sqrt(4 / 365) * 100, 3);
  });
  it("nulls on missing iv or dte", () => {
    expect(ivApproxMovePct(null, 4)).toBeNull();
    expect(ivApproxMovePct(0.43, null)).toBeNull();
    expect(ivApproxMovePct(0.43, 0)).toBeNull();
  });
});

describe("pickPostPrintExpiry", () => {
  const exps = ["2026-07-11", "2026-07-14", "2026-07-18", "2026-07-25", "2026-08-15"];
  it("AMC: strictly after event date", () => {
    expect(pickPostPrintExpiry(exps, "2026-07-14", "AMC")).toBe("2026-07-18");
  });
  it("BMO: same-day expiry allowed", () => {
    expect(pickPostPrintExpiry(exps, "2026-07-14", "BMO")).toBe("2026-07-14");
  });
  it("null eventTime treated like AMC", () => {
    expect(pickPostPrintExpiry(exps, "2026-07-14", null)).toBe("2026-07-18");
  });
  it("21-day ceiling: far-month-only chain → null", () => {
    expect(pickPostPrintExpiry(["2026-08-15"], "2026-07-14", "AMC")).toBeNull();
  });
});

describe("pickAtmStrike / computeMid", () => {
  it("nearest strike to spot", () => {
    expect(pickAtmStrike([120, 125, 130, 135], 128.9)).toBe(130);
    expect(pickAtmStrike([], 128.9)).toBeNull();
  });
  it("mid from bid/ask when sane", () => {
    expect(computeMid(3.0, 3.4, 2.0)).toBeCloseTo(3.2);
  });
  it("wide spread (>50% of mid) falls to last", () => {
    expect(computeMid(1.0, 3.0, 2.1)).toBe(2.1); // spread 2.0 > 0.5×2.0
  });
  it("no bid → last; no last → null", () => {
    expect(computeMid(0, 3.4, 2.0)).toBe(2.0);
    expect(computeMid(null, null, null)).toBeNull();
  });
});

describe("defaultExpiryFriday", () => {
  it("first Friday on/after the event date", () => {
    expect(defaultExpiryFriday("2026-07-14")).toBe("2026-07-17"); // Tue → Fri
    expect(defaultExpiryFriday("2026-07-17")).toBe("2026-07-17"); // Fri → same day
  });
});

it("exports the 60% corrupt ceiling", () => {
  expect(IMPLIED_MOVE_CORRUPT_CEILING_PCT).toBe(60);
});
```

- [ ] **Step 2: Run tests — verify fail**

Run: `npx vitest run tests/earnings/implied-move.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```typescript
// lib/earnings/implied-move.ts
/**
 * Pure implied-move math for the earnings intelligence tier (audit §4C #9).
 * ZERO imports by design (plausibility.ts pattern) — trivially testable and
 * safe to mirror if the Worker ever needs it.
 *
 * Percent-unit convention: all *Pct returns are PERCENT (4.8 = ±4.8%).
 */

/** Straddle quotes above this are corrupt-quote territory, not event pricing. */
export const IMPLIED_MOVE_CORRUPT_CEILING_PCT = 60;

/** Expiries further than this past the print overstate the event move. */
const EXPIRY_CEILING_DAYS = 21;

const DAY_MS = 24 * 60 * 60 * 1000;

function fin(n: number | null | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

export function straddleImpliedMovePct(
  callMid: number | null, putMid: number | null, spot: number | null,
): number | null {
  if (!fin(callMid) || !fin(putMid) || !fin(spot)) return null;
  if (callMid <= 0 || putMid <= 0 || spot <= 0) return null;
  return ((callMid + putMid) / spot) * 100;
}

export function ivApproxMovePct(iv: number | null, dteDays: number | null): number | null {
  if (!fin(iv) || !fin(dteDays) || iv <= 0 || dteDays <= 0) return null;
  return iv * Math.sqrt(dteDays / 365) * 100;
}

export function pickPostPrintExpiry(
  expirations: string[], eventDate: string, eventTime: "BMO" | "AMC" | null,
): string | null {
  const evMs = Date.parse(`${eventDate}T00:00:00Z`);
  if (!Number.isFinite(evMs)) return null;
  const eligible = expirations
    .filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e))
    .filter((e) => {
      const ms = Date.parse(`${e}T00:00:00Z`);
      const sameDayOk = eventTime === "BMO";
      return sameDayOk ? ms >= evMs : ms > evMs;
    })
    .sort();
  const first = eligible[0];
  if (!first) return null;
  const dte = (Date.parse(`${first}T00:00:00Z`) - evMs) / DAY_MS;
  return dte <= EXPIRY_CEILING_DAYS ? first : null;
}

export function pickAtmStrike(strikes: number[], spot: number): number | null {
  if (!fin(spot) || strikes.length === 0) return null;
  let best: number | null = null;
  let bestDist = Infinity;
  for (const s of strikes) {
    if (!fin(s)) continue;
    const d = Math.abs(s - spot);
    if (d < bestDist) { best = s; bestDist = d; }
  }
  return best;
}

export function computeMid(
  bid: number | null, ask: number | null, last: number | null,
): number | null {
  if (fin(bid) && fin(ask) && bid > 0 && ask >= bid) {
    const mid = (bid + ask) / 2;
    if (ask - bid <= 0.5 * mid) return mid; // spread sanity
  }
  if (fin(last) && last > 0) return last;
  return null;
}

/** First Friday on/after eventDate — DTE assumption when no chain resolved. */
export function defaultExpiryFriday(eventDate: string): string {
  const ms = Date.parse(`${eventDate}T00:00:00Z`);
  const d = new Date(ms);
  const dow = d.getUTCDay(); // Fri = 5
  const add = (5 - dow + 7) % 7;
  const out = new Date(ms + add * DAY_MS);
  return out.toISOString().slice(0, 10);
}
```

- [ ] **Step 4: Run tests — verify pass**

Run: `npx vitest run tests/earnings/implied-move.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/earnings/implied-move.ts tests/earnings/implied-move.test.ts
git commit -m "feat(earnings-intel): pure implied-move engine (straddle, IV approx, expiry/ATM pickers)"
```

---

### Task 4: Yahoo daily closes helper + report-history engine (AV + moves + summarize)

**Files:**
- Create: `lib/quotes/yahoo-daily.ts`
- Create: `lib/earnings/report-history.ts`
- Test: `tests/earnings/report-history.test.ts`

**Interfaces:**
- Consumes: `replaceReportHistory`, `ReportHistoryRow` (Task 2).
- Produces:
  - `fetchYahooDailyCloses(symbol: string, fromDate: string, toDate: string, fetchImpl?: typeof fetch): Promise<Array<{ date: string; close: number }>>` — ascending, ET-anchored dates
  - `fetchAvEarningsHistory(symbol: string, deps: { apiKey: string; fetchImpl?: typeof fetch }): Promise<AvReport[]>` where `AvReport = { fiscalDateEnding: string | null; reportedDate: string; reportedEPS: number | null; estimatedEPS: number | null; surprisePercentage: number | null; reportTime: "pre-market" | "post-market" | null }`
  - `computePostPrintMoves(reports: AvReport[], closes: Array<{ date: string; close: number }>): ReportHistoryRow[]` (PURE)
  - `summarizeHistory(rows: ReportHistoryRow[]): { avgAbsMovePct: number | null; beatCount: number; missCount: number; quarterCount: number }` (PURE; newest ≤8 rows)
  - `refreshReportHistory(db, symbol, deps?: { apiKey?: string | null; fetchImpl?: typeof fetch }): Promise<boolean>` — false (no-op) when key missing/fetch fails; true on cache write

- [ ] **Step 1: Write failing tests**

```typescript
// tests/earnings/report-history.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  fetchAvEarningsHistory, computePostPrintMoves, summarizeHistory, refreshReportHistory,
  type AvReport,
} from "@/lib/earnings/report-history";
import { getReportHistoryForFamily } from "@/lib/queries/earnings-intel";

const AV_JSON = {
  symbol: "TER",
  quarterlyEarnings: [
    { fiscalDateEnding: "2026-03-31", reportedDate: "2026-04-22", reportedEPS: "1.42",
      estimatedEPS: "1.35", surprise: "0.07", surprisePercentage: "5.1852", reportTime: "post-market" },
    { fiscalDateEnding: "2025-12-31", reportedDate: "2026-01-28", reportedEPS: "1.10",
      estimatedEPS: "None", surprise: "None", surprisePercentage: "None", reportTime: "pre-market" },
  ],
};

function mockFetch(json: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(json), { status: 200 })) as typeof fetch;
}

describe("fetchAvEarningsHistory", () => {
  it("parses numeric strings, maps 'None' → null", async () => {
    const reports = await fetchAvEarningsHistory("TER", { apiKey: "k", fetchImpl: mockFetch(AV_JSON) });
    expect(reports).toHaveLength(2);
    expect(reports[0].reportedEPS).toBeCloseTo(1.42);
    expect(reports[0].surprisePercentage).toBeCloseTo(5.1852, 3);
    expect(reports[1].estimatedEPS).toBeNull();
    expect(reports[1].reportTime).toBe("pre-market");
  });
  it("returns [] on AV error / rate-limit note payload", async () => {
    expect(await fetchAvEarningsHistory("TER", { apiKey: "k", fetchImpl: mockFetch({ Note: "rate limited" }) })).toEqual([]);
  });
});

describe("computePostPrintMoves", () => {
  // Trading days around a Wed 2026-04-22 AMC print and a Wed 2026-01-28 BMO print.
  const closes = [
    { date: "2026-01-27", close: 100 }, { date: "2026-01-28", close: 103 },
    { date: "2026-04-21", close: 120 }, { date: "2026-04-22", close: 121 },
    { date: "2026-04-23", close: 126 },
  ];
  const reports: AvReport[] = [
    { fiscalDateEnding: "2026-03-31", reportedDate: "2026-04-22", reportedEPS: 1.42,
      estimatedEPS: 1.35, surprisePercentage: 5.19, reportTime: "post-market" },
    { fiscalDateEnding: "2025-12-31", reportedDate: "2026-01-28", reportedEPS: 1.1,
      estimatedEPS: 1.0, surprisePercentage: 10, reportTime: "pre-market" },
  ];
  it("AMC: next close vs print-day close; BMO: print-day close vs prior close", () => {
    const rows = computePostPrintMoves(reports, closes);
    expect(rows[0].postPrintMovePct).toBeCloseTo(((126 - 121) / 121) * 100, 3);
    expect(rows[1].postPrintMovePct).toBeCloseTo(3, 3);
  });
  it("unknown reportTime defaults to the AMC convention", () => {
    const rows = computePostPrintMoves(
      [{ ...reports[0], reportTime: null }], closes);
    expect(rows[0].postPrintMovePct).toBeCloseTo(((126 - 121) / 121) * 100, 3);
  });
  it("missing closes → null move, surprise preserved", () => {
    const rows = computePostPrintMoves(reports, []);
    expect(rows[0].postPrintMovePct).toBeNull();
    expect(rows[0].surprisePct).toBeCloseTo(5.19);
  });
  it("AMC print on a non-trading day uses the prior trading day as D", () => {
    // Print date Sat 2026-04-25 → D = 4/23 (last close ≤ date), D+1 missing → null
    const rows = computePostPrintMoves(
      [{ ...reports[0], reportedDate: "2026-04-25" }], closes);
    expect(rows[0].postPrintMovePct).toBeNull();
  });
});

describe("summarizeHistory", () => {
  it("averages |move| and counts beats over rows with both EPS values", () => {
    const rows = [
      { reportedDate: "2026-04-22", fiscalDateEnding: null, epsActual: 1.42, epsEstimate: 1.35, surprisePct: 5, reportTime: null, postPrintMovePct: 4.1 },
      { reportedDate: "2026-01-28", fiscalDateEnding: null, epsActual: 0.9, epsEstimate: 1.0, surprisePct: -10, reportTime: null, postPrintMovePct: -2.3 },
      { reportedDate: "2025-10-28", fiscalDateEnding: null, epsActual: 1.0, epsEstimate: null, surprisePct: null, reportTime: null, postPrintMovePct: null },
    ];
    const s = summarizeHistory(rows);
    expect(s.avgAbsMovePct).toBeCloseTo((4.1 + 2.3) / 2, 3);
    expect(s.beatCount).toBe(1);
    expect(s.missCount).toBe(1);
    expect(s.quarterCount).toBe(3);
  });
  it("empty → null average, zero counts", () => {
    expect(summarizeHistory([])).toEqual({ avgAbsMovePct: null, beatCount: 0, missCount: 0, quarterCount: 0 });
  });
});

describe("refreshReportHistory", () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(":memory:"); runMigrations(db); });

  it("fetches AV + Yahoo (DI), writes rows, returns true", async () => {
    const yahooJson = {
      chart: { result: [{ timestamp: [1745305200, 1745391600, 1745478000],
        indicators: { quote: [{ close: [120, 121, 126] }] } }] },
    };
    let call = 0;
    const fetchImpl = (async (url: RequestInfo | URL) => {
      call++;
      const u = String(url);
      if (u.includes("alphavantage")) return new Response(JSON.stringify(AV_JSON), { status: 200 });
      return new Response(JSON.stringify(yahooJson), { status: 200 });
    }) as typeof fetch;
    const ok = await refreshReportHistory(db, "TER", { apiKey: "k", fetchImpl });
    expect(ok).toBe(true);
    expect(getReportHistoryForFamily(db, "TER").length).toBeGreaterThan(0);
    expect(call).toBeGreaterThanOrEqual(2);
  });

  it("no API key → false, no writes, no fetches", async () => {
    const fetchImpl = (async () => { throw new Error("must not be called"); }) as unknown as typeof fetch;
    expect(await refreshReportHistory(db, "TER", { apiKey: null, fetchImpl })).toBe(false);
    expect(getReportHistoryForFamily(db, "TER")).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests — verify fail**

Run: `npx vitest run tests/earnings/report-history.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement `lib/quotes/yahoo-daily.ts`**

```typescript
// lib/quotes/yahoo-daily.ts
/**
 * Daily closes from Yahoo's unofficial chart endpoint — same endpoint family
 * and risk posture as lib/benchmark/yahoo-benchmarks.ts (graceful [] on any
 * breakage). Dates are ET-anchored (the exchange's trading day).
 */

export interface DailyClose { date: string; close: number }

const ET_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" });

export async function fetchYahooDailyCloses(
  symbol: string,
  fromDate: string, // YYYY-MM-DD inclusive
  toDate: string,   // YYYY-MM-DD inclusive
  fetchImpl: typeof fetch = fetch,
): Promise<DailyClose[]> {
  try {
    const p1 = Math.floor(Date.parse(`${fromDate}T00:00:00-05:00`) / 1000);
    const p2 = Math.floor(Date.parse(`${toDate}T23:59:59-05:00`) / 1000);
    const url =
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
      `?interval=1d&period1=${p1}&period2=${p2}`;
    const resp = await fetchImpl(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!resp.ok) return [];
    const json = (await resp.json()) as {
      chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<{ close?: Array<number | null> }> } }> };
    };
    const r = json.chart?.result?.[0];
    const ts = r?.timestamp ?? [];
    const closes = r?.indicators?.quote?.[0]?.close ?? [];
    const out: DailyClose[] = [];
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      if (typeof c !== "number" || !Number.isFinite(c)) continue;
      out.push({ date: ET_DATE.format(new Date(ts[i] * 1000)), close: c });
    }
    return out;
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Implement `lib/earnings/report-history.ts`**

```typescript
// lib/earnings/report-history.ts
/**
 * Past-print history for the earnings intelligence tier (audit §4C #10).
 * Surprise history from Alpha Vantage EARNINGS (free tier; key shared with
 * transcripts — callers cap invocations); post-print moves from Yahoo daily
 * closes. Own calendar_events history is one season deep — NOT the source.
 */
import type Database from "better-sqlite3";
import { fetchYahooDailyCloses, type DailyClose } from "@/lib/quotes/yahoo-daily";
import { replaceReportHistory, type ReportHistoryRow } from "@/lib/mutations/earnings-intel";

export interface AvReport {
  fiscalDateEnding: string | null;
  reportedDate: string;
  reportedEPS: number | null;
  estimatedEPS: number | null;
  surprisePercentage: number | null;
  reportTime: "pre-market" | "post-market" | null;
}

const KEEP_QUARTERS = 12;
const SUMMARY_QUARTERS = 8;

function num(v: unknown): number | null {
  if (v == null || v === "None" || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

export async function fetchAvEarningsHistory(
  symbol: string,
  deps: { apiKey: string; fetchImpl?: typeof fetch },
): Promise<AvReport[]> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const url =
      `https://www.alphavantage.co/query?function=EARNINGS` +
      `&symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(deps.apiKey)}`;
    const resp = await fetchImpl(url);
    if (!resp.ok) return [];
    const json = (await resp.json()) as { quarterlyEarnings?: Array<Record<string, unknown>> };
    const q = json.quarterlyEarnings;
    if (!Array.isArray(q)) return []; // covers AV "Note"/"Information" rate-limit payloads
    return q
      .filter((r) => typeof r.reportedDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.reportedDate as string))
      .slice(0, KEEP_QUARTERS)
      .map((r) => ({
        fiscalDateEnding: typeof r.fiscalDateEnding === "string" ? r.fiscalDateEnding : null,
        reportedDate: r.reportedDate as string,
        reportedEPS: num(r.reportedEPS),
        estimatedEPS: num(r.estimatedEPS),
        surprisePercentage: num(r.surprisePercentage),
        reportTime:
          r.reportTime === "pre-market" || r.reportTime === "post-market" ? r.reportTime : null,
      }));
  } catch {
    return [];
  }
}

/**
 * Post-print move conventions (next-day close proxy; intraday T+2h is not
 * reconstructable for past quarters):
 *   post-market (or unknown): (close[D+1] − close[D]) / close[D]
 *   pre-market:               (close[D]   − close[D−1]) / close[D−1]
 * where D = last trading day ≤ reportedDate (post) / first ≥ reportedDate (pre),
 * and D±1 are ADJACENT rows in the (ascending) close series.
 */
export function computePostPrintMoves(
  reports: AvReport[],
  closes: DailyClose[],
): ReportHistoryRow[] {
  const sorted = [...closes].sort((a, b) => (a.date < b.date ? -1 : 1));
  return reports.map((r) => {
    let movePct: number | null = null;
    if (sorted.length > 0) {
      if (r.reportTime === "pre-market") {
        const di = sorted.findIndex((c) => c.date >= r.reportedDate);
        if (di > 0) movePct = ((sorted[di].close - sorted[di - 1].close) / sorted[di - 1].close) * 100;
      } else {
        let di = -1;
        for (let i = sorted.length - 1; i >= 0; i--) {
          if (sorted[i].date <= r.reportedDate) { di = i; break; }
        }
        if (di >= 0 && di + 1 < sorted.length) {
          movePct = ((sorted[di + 1].close - sorted[di].close) / sorted[di].close) * 100;
        }
      }
    }
    return {
      reportedDate: r.reportedDate,
      fiscalDateEnding: r.fiscalDateEnding,
      epsActual: r.reportedEPS,
      epsEstimate: r.estimatedEPS,
      surprisePct: r.surprisePercentage,
      reportTime: r.reportTime,
      postPrintMovePct: movePct != null && Number.isFinite(movePct) ? movePct : null,
    };
  });
}

export interface HistorySummary {
  avgAbsMovePct: number | null;
  beatCount: number;
  missCount: number;
  quarterCount: number;
}

export function summarizeHistory(rows: ReportHistoryRow[]): HistorySummary {
  const recent = rows.slice(0, SUMMARY_QUARTERS);
  const moves = recent.map((r) => r.postPrintMovePct).filter((m): m is number => m != null);
  let beat = 0, miss = 0;
  for (const r of recent) {
    if (r.epsActual == null || r.epsEstimate == null) continue;
    if (r.epsActual > r.epsEstimate) beat++;
    else if (r.epsActual < r.epsEstimate) miss++;
  }
  return {
    avgAbsMovePct: moves.length
      ? moves.reduce((a, m) => a + Math.abs(m), 0) / moves.length
      : null,
    beatCount: beat,
    missCount: miss,
    quarterCount: recent.length,
  };
}

/** Fetch AV + Yahoo and rewrite the symbol's history cache. Never throws. */
export async function refreshReportHistory(
  db: Database.Database,
  symbol: string,
  deps: { apiKey?: string | null; fetchImpl?: typeof fetch } = {},
): Promise<boolean> {
  const apiKey = deps.apiKey !== undefined ? deps.apiKey : (process.env.ALPHA_VANTAGE_API_KEY ?? null);
  if (!apiKey) return false;
  try {
    const reports = await fetchAvEarningsHistory(symbol, { apiKey, fetchImpl: deps.fetchImpl });
    if (reports.length === 0) return false;
    const oldest = reports[reports.length - 1].reportedDate;
    const from = new Date(Date.parse(`${oldest}T00:00:00Z`) - 7 * 86400_000).toISOString().slice(0, 10);
    const to = new Date().toISOString().slice(0, 10);
    const closes = await fetchYahooDailyCloses(symbol, from, to, deps.fetchImpl ?? fetch);
    replaceReportHistory(db, symbol, computePostPrintMoves(reports, closes));
    return true;
  } catch (e) {
    console.warn(`[earnings-intel] history refresh failed for ${symbol}:`, e);
    return false;
  }
}
```

- [ ] **Step 5: Run tests — verify pass**

Run: `npx vitest run tests/earnings/report-history.test.ts`
Expected: PASS. (If the Yahoo mock's ET-date mapping shifts a day, adjust the fixture timestamps — they're 2025-04-22..24 07:00 ET equivalents; what matters is 3 ascending dates.)

- [ ] **Step 6: Commit**

```bash
git add lib/quotes/yahoo-daily.ts lib/earnings/report-history.ts tests/earnings/report-history.test.ts
git commit -m "feat(earnings-intel): AV surprise history + Yahoo post-print moves + summary"
```

---

### Task 5: IBKR option-chain resolution + snapshot bid/ask fields

**Files:**
- Modify: `lib/ibkr/market-data.ts` (SNAPSHOT_FIELDS + ParsedQuote + parseSnapshotRow)
- Create: `lib/ibkr/option-chain.ts`
- Test: `tests/ibkr/option-chain.test.ts` (+ extend `tests/ibkr/market-data.test.ts` if it exists — check `ls tests/ibkr/`)

**Interfaces:**
- Consumes: **Task 1's PROBE RESULTS block** (`scripts/probe-ibkr-option-chain.ts` header) — bid/ask field codes and secdef param shapes. READ IT FIRST. If the probe recorded codes other than 84/86, use the probed values everywhere below.
- Consumes: `pickPostPrintExpiry`, `pickAtmStrike` (Task 3); `signedRequest(cfg, lst, method, path, query)` (`lib/ibkr/oauth-client.ts`).
- Produces:
  - `SNAPSHOT_FIELDS.BID` / `SNAPSHOT_FIELDS.ASK` (probe-verified codes) — NOT added to the default `SNAPSHOT_FIELD_CODES` (equity cache path unchanged); callers opt in via `opts.fields`.
  - `ParsedQuote.bid: number | null; ask: number | null` (null when field absent).
  - `resolveAtmContracts(cfg, lst, args: { conid: number; eventDate: string; eventTime: "BMO" | "AMC" | null; spot: number }, deps?: { request?: typeof signedRequest }): Promise<{ callConid: number; putConid: number; expiry: string; strike: number } | null>`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/ibkr/option-chain.test.ts
import { describe, it, expect, vi } from "vitest";
import { resolveAtmContracts } from "@/lib/ibkr/option-chain";
import { parseSnapshotRow } from "@/lib/ibkr/market-data";

const CFG = {} as never; // config is opaque to the resolver; requests are injected

function respondJson(json: unknown) {
  return new Response(JSON.stringify(json), { status: 200 });
}

// Fake secdef surfaces: strikes for the month, info per right with maturityDates.
function fakeRequest(overrides: Partial<Record<string, unknown>> = {}) {
  return vi.fn(async (_cfg, _lst, _m, path: string, query: Record<string, string>) => {
    if (path.includes("secdef/strikes")) {
      return respondJson(overrides.strikes ?? { call: [120, 125, 130, 135], put: [120, 125, 130, 135] });
    }
    if (path.includes("secdef/info")) {
      return respondJson(
        overrides.info ?? [
          { conid: query.right === "C" ? 9001 : 9002, maturityDate: "20260714" },
          { conid: query.right === "C" ? 9003 : 9004, maturityDate: "20260718" },
        ],
      );
    }
    throw new Error(`unexpected path ${path}`);
  });
}

describe("resolveAtmContracts", () => {
  it("picks ATM strike and the first strictly-post-print expiry (AMC)", async () => {
    const request = fakeRequest();
    const out = await resolveAtmContracts(CFG, "lst", {
      conid: 265598, eventDate: "2026-07-14", eventTime: "AMC", spot: 128.9,
    }, { request: request as never });
    expect(out).toEqual({ callConid: 9003, putConid: 9004, expiry: "2026-07-18", strike: 130 });
  });

  it("null when no eligible expiry within 21 days", async () => {
    const request = fakeRequest({
      info: [{ conid: 9001, maturityDate: "20260910" }],
    });
    const out = await resolveAtmContracts(CFG, "lst", {
      conid: 265598, eventDate: "2026-07-14", eventTime: "AMC", spot: 128.9,
    }, { request: request as never });
    expect(out).toBeNull();
  });

  it("null on empty strikes / request failure", async () => {
    const request = vi.fn(async () => respondJson({ call: [], put: [] }));
    expect(await resolveAtmContracts(CFG, "lst", {
      conid: 1, eventDate: "2026-07-14", eventTime: "AMC", spot: 100,
    }, { request: request as never })).toBeNull();

    const failing = vi.fn(async () => { throw new Error("boom"); });
    expect(await resolveAtmContracts(CFG, "lst", {
      conid: 1, eventDate: "2026-07-14", eventTime: "AMC", spot: 100,
    }, { request: failing as never })).toBeNull();
  });
});

describe("parseSnapshotRow bid/ask", () => {
  it("parses probed bid/ask codes; absent → null", () => {
    // Replace "84"/"86" with the probe-verified codes if they differ.
    const q = parseSnapshotRow({ conid: 9003, "31": "3.20", "84": "3.00", "86": "3.40" });
    expect(q.bid).toBeCloseTo(3.0);
    expect(q.ask).toBeCloseTo(3.4);
    expect(parseSnapshotRow({ conid: 9003, "31": "3.20" }).bid).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests — verify fail**

Run: `npx vitest run tests/ibkr/option-chain.test.ts`
Expected: FAIL.

- [ ] **Step 3: Extend `lib/ibkr/market-data.ts`**

Add to `SNAPSHOT_FIELDS` (using the probe-verified codes — 84/86 shown as the expected values):

```typescript
export const SNAPSHOT_FIELDS = {
  LAST: "31",
  BID: "84",  // probe-verified 2026-07-08 (scripts/probe-ibkr-option-chain.ts) — bid price
  ASK: "86",  // probe-verified 2026-07-08 — ask price
  IV: "7283",
  HV: "7284",
  WK52_HIGH: "7293",
  WK52_LOW: "7294",
} as const;
```

Do NOT add BID/ASK to `SNAPSHOT_FIELD_CODES` (the equity quote-cache request set is unchanged). Extend `ParsedQuote` with `bid: number | null; ask: number | null;` and in `parseSnapshotRow` parse them with the existing `parsePlainNumber` (or the prefix-stripping parser IF the probe showed prefix markers on bid/ask — follow the probe).

- [ ] **Step 4: Implement `lib/ibkr/option-chain.ts`**

```typescript
// lib/ibkr/option-chain.ts
/**
 * Headless option-chain resolution for the earnings straddle (audit §4C #9).
 * Endpoint params pinned by scripts/probe-ibkr-option-chain.ts (2026-07-08) —
 * adjust here ONLY from a fresh probe, never from docs alone.
 */
import { signedRequest, type IbkrOAuthConfig } from "./oauth-client";
import { pickPostPrintExpiry, pickAtmStrike } from "@/lib/earnings/implied-move";

export interface AtmContracts {
  callConid: number;
  putConid: number;
  expiry: string; // YYYY-MM-DD
  strike: number;
}

interface ResolveArgs {
  conid: number;
  eventDate: string;
  eventTime: "BMO" | "AMC" | null;
  spot: number;
}

/** "20260718" → "2026-07-18"; null on anything else. */
function isoFromMaturity(m: unknown): string | null {
  if (typeof m !== "string" || !/^\d{8}$/.test(m)) return null;
  return `${m.slice(0, 4)}-${m.slice(4, 6)}-${m.slice(6, 8)}`;
}

/** IBKR month token for a date: "JUL26". */
function monthToken(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  const mon = d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }).toUpperCase();
  return `${mon}${String(d.getUTCFullYear()).slice(2)}`;
}

/** Months to scan: the event's month, plus the next month when the print is in the last week. */
function candidateMonths(eventDate: string): string[] {
  const months = [monthToken(eventDate)];
  const d = new Date(`${eventDate}T12:00:00Z`);
  const nextMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  if (d.getUTCDate() > lastDay - 7) months.push(monthToken(nextMonth.toISOString().slice(0, 10)));
  return months;
}

export async function resolveAtmContracts(
  cfg: IbkrOAuthConfig,
  lst: string,
  args: ResolveArgs,
  deps: { request?: typeof signedRequest } = {},
): Promise<AtmContracts | null> {
  const request = deps.request ?? signedRequest;
  try {
    for (const month of candidateMonths(args.eventDate)) {
      const strikesResp = await request(cfg, lst, "GET", "/iserver/secdef/strikes", {
        conid: String(args.conid), sectype: "OPT", month, exchange: "SMART",
      });
      if (!strikesResp.ok) continue;
      const strikesJson = (await strikesResp.json()) as { call?: number[]; put?: number[] };
      const strike = pickAtmStrike(strikesJson.call ?? [], args.spot);
      if (strike == null) continue;

      const byRight: Record<"C" | "P", Map<string, number>> = { C: new Map(), P: new Map() };
      for (const right of ["C", "P"] as const) {
        const infoResp = await request(cfg, lst, "GET", "/iserver/secdef/info", {
          conid: String(args.conid), sectype: "OPT", month, strike: String(strike), right, exchange: "SMART",
        });
        if (!infoResp.ok) continue;
        const info = (await infoResp.json()) as Array<{ conid?: unknown; maturityDate?: unknown }>;
        if (!Array.isArray(info)) continue;
        for (const c of info) {
          const iso = isoFromMaturity(c.maturityDate);
          const cid = typeof c.conid === "number" ? c.conid : Number(c.conid);
          if (iso && Number.isFinite(cid)) byRight[right].set(iso, cid);
        }
      }
      const shared = [...byRight.C.keys()].filter((e) => byRight.P.has(e));
      const expiry = pickPostPrintExpiry(shared, args.eventDate, args.eventTime);
      if (!expiry) continue;
      return {
        callConid: byRight.C.get(expiry)!,
        putConid: byRight.P.get(expiry)!,
        expiry,
        strike,
      };
    }
    return null;
  } catch (e) {
    console.warn(`[earnings-intel] chain resolve failed for conid ${args.conid}:`, e);
    return null;
  }
}
```

Adjust param names/shapes to match the PROBE RESULTS block if they differ.

- [ ] **Step 5: Run tests — verify pass**

Run: `npx vitest run tests/ibkr/option-chain.test.ts tests/ibkr/ tests/quotes/ 2>/dev/null || npx vitest run tests/ibkr/option-chain.test.ts`
Then the full ibkr/market-data suites: `npx vitest run tests/ --silent -t "parseSnapshotRow" ` — or simply `npx vitest run` filtered to touched dirs. Expected: PASS, no regressions in existing market-data tests.

- [ ] **Step 6: Commit**

```bash
git add lib/ibkr/market-data.ts lib/ibkr/option-chain.ts tests/ibkr/option-chain.test.ts
git commit -m "feat(earnings-intel): headless ATM chain resolution + probed bid/ask snapshot fields"
```

---

### Task 6: `ensureIntelForEvents` orchestrator

**Files:**
- Create: `lib/earnings/intel.ts`
- Test: `tests/earnings/intel.test.ts`

**Interfaces:**
- Consumes: everything above — `loadIbkrConfig` (`lib/ibkr/config.ts`), `openSession` (`lib/ibkr/web-api.ts`), `resolveAtmContracts`, `getMarketDataSnapshot` + `SNAPSHOT_FIELDS`, pure math (Task 3), `refreshReportHistory` + `isHistoryStale`, `upsertEarningsIntel`, `getSecurityIdForSymbolWithSiblings` (`lib/queries/briefing-symbols.ts`), `getSecurityQuote` (`lib/queries/security-quotes.ts`).
- Produces:
  - `IntelEvent = { id: number; symbol: string; event_date: string; event_time: string | null }`
  - `ensureIntelForEvents(db, events: IntelEvent[], opts?: { forceFresh?: boolean }, deps?: IntelDeps): Promise<void>` — never throws
  - `__resetIntelTtlForTests(): void`
  - `INTEL_TTL_MS = 30 * 60 * 1000`, `AV_FETCH_CAP_PER_RUN = 5`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/earnings/intel.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { ensureIntelForEvents, __resetIntelTtlForTests } from "@/lib/earnings/intel";
import { getIntelForEvents } from "@/lib/queries/earnings-intel";

let db: Database.Database;

function seed(symbol: string, opts: { conid?: number | null; spot?: number; iv?: number | null } = {}) {
  const secId = db.prepare(
    "INSERT INTO securities (symbol, name, security_type, source_key, ib_con_id) VALUES (?, ?, 'Stock', ?, ?)"
  ).run(symbol, symbol, `t:${symbol}`, opts.conid ?? 111).lastInsertRowid as number;
  db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2026-07-13', ?, 'tws')")
    .run(secId, opts.spot ?? 128.9);
  if (opts.iv !== null) {
    db.prepare(
      "INSERT INTO security_quotes (security_id, as_of_date, iv_underlying) VALUES (?, '2026-07-13', ?)"
    ).run(secId, opts.iv ?? 0.43);
  }
  const eventId = db.prepare(
    `INSERT INTO calendar_events (source, source_key, event_type, event_date, event_time, week_of, title)
     VALUES ('finnhub', 'finnhub:${symbol}:2026-07-14', 'earnings', '2026-07-14', 'AMC', '2026-07-13', '${symbol} earnings')`
  ).run().lastInsertRowid as number;
  return { secId, eventId };
}

const EV = (id: number, symbol: string) =>
  ({ id, symbol, event_date: "2026-07-14", event_time: "AMC" });

function mkDeps(over: Record<string, unknown> = {}) {
  return {
    loadConfig: vi.fn(() => ({}) as never),
    openSession: vi.fn(async () => "lst"),
    resolveChain: vi.fn(async () => ({ callConid: 9003, putConid: 9004, expiry: "2026-07-18", strike: 130 })),
    snapshot: vi.fn(async () => [
      { conid: 9003, last: 3.2, bid: 3.0, ask: 3.4, ivUnderlying: null, hv30d: null, week52High: null, week52Low: null },
      { conid: 9004, last: 3.0, bid: 2.8, ask: 3.2, ivUnderlying: null, hv30d: null, week52High: null, week52Low: null },
    ]),
    refreshHistory: vi.fn(async () => true),
    historyStale: vi.fn(() => true),
    now: () => Date.parse("2026-07-14T14:00:00Z"),
    ...over,
  };
}

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
  __resetIntelTtlForTests();
});

describe("ensureIntelForEvents", () => {
  it("straddle road: writes implied move from ATM mids", async () => {
    const { eventId } = seed("TER");
    const deps = mkDeps();
    await ensureIntelForEvents(db, [EV(eventId, "TER")], {}, deps as never);
    const intel = getIntelForEvents(db, [eventId]).get(eventId)!;
    expect(intel.impliedMethod).toBe("straddle");
    expect(intel.impliedMovePct).toBeCloseTo(((3.2 + 3.0) / 128.9) * 100, 2);
    expect(intel.expiryUsed).toBe("2026-07-18");
  });

  it("falls back to IV approximation when the chain fails", async () => {
    const { eventId } = seed("TER", { iv: 0.43 });
    const deps = mkDeps({ resolveChain: vi.fn(async () => null) });
    await ensureIntelForEvents(db, [EV(eventId, "TER")], {}, deps as never);
    const intel = getIntelForEvents(db, [eventId]).get(eventId)!;
    expect(intel.impliedMethod).toBe("iv_approx");
    expect(intel.impliedMovePct).toBeGreaterThan(0);
  });

  it("corrupt straddle (>60%) falls to IV road", async () => {
    const { eventId } = seed("TER", { iv: 0.43, spot: 10 }); // straddle 6.2/10 = 62%
    const deps = mkDeps();
    await ensureIntelForEvents(db, [EV(eventId, "TER")], {}, deps as never);
    expect(getIntelForEvents(db, [eventId]).get(eventId)!.impliedMethod).toBe("iv_approx");
  });

  it("no chain + no IV → null-method row still recorded", async () => {
    const { eventId } = seed("TER", { iv: null });
    const deps = mkDeps({ resolveChain: vi.fn(async () => null) });
    await ensureIntelForEvents(db, [EV(eventId, "TER")], {}, deps as never);
    const intel = getIntelForEvents(db, [eventId]).get(eventId)!;
    expect(intel.impliedMovePct).toBeNull();
    expect(intel.impliedMethod).toBeNull();
  });

  it("TTL: second call within 30 min is a no-op; forceFresh bypasses", async () => {
    const { eventId } = seed("TER");
    const deps = mkDeps();
    await ensureIntelForEvents(db, [EV(eventId, "TER")], {}, deps as never);
    await ensureIntelForEvents(db, [EV(eventId, "TER")], {}, deps as never);
    expect(deps.resolveChain).toHaveBeenCalledTimes(1);
    await ensureIntelForEvents(db, [EV(eventId, "TER")], { forceFresh: true }, deps as never);
    expect(deps.resolveChain).toHaveBeenCalledTimes(2);
  });

  it("caps history refreshes at 5 per run, family-deduped", async () => {
    const events = ["A1", "A2", "A3", "A4", "A5", "A6", "A7"].map((s) => {
      const { eventId } = seed(s, { conid: null });
      return EV(eventId, s);
    });
    const deps = mkDeps({ resolveChain: vi.fn(async () => null) });
    await ensureIntelForEvents(db, events, {}, deps as never);
    expect(deps.refreshHistory).toHaveBeenCalledTimes(5);
  });

  it("never throws when everything explodes", async () => {
    const { eventId } = seed("TER");
    const deps = mkDeps({
      openSession: vi.fn(async () => { throw new Error("oauth down"); }),
      refreshHistory: vi.fn(async () => { throw new Error("av down"); }),
    });
    await expect(
      ensureIntelForEvents(db, [EV(eventId, "TER")], {}, deps as never)
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests — verify fail**

Run: `npx vitest run tests/earnings/intel.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
// lib/earnings/intel.ts
/**
 * Orchestrator for the earnings intelligence tier (audit §4C #9/#10).
 * Best-effort by contract: NEVER throws to a caller — a failed straddle or a
 * rate-limited AV call degrades to cached/absent data, and the preview send
 * path (claim mutex, marker dance) proceeds untouched.
 */
import type Database from "better-sqlite3";
import { loadIbkrConfig } from "@/lib/ibkr/config";
import { openSession } from "@/lib/ibkr/web-api";
import { resolveAtmContracts } from "@/lib/ibkr/option-chain";
import { getMarketDataSnapshot, SNAPSHOT_FIELDS } from "@/lib/ibkr/market-data";
import {
  straddleImpliedMovePct, ivApproxMovePct, computeMid, defaultExpiryFriday,
  IMPLIED_MOVE_CORRUPT_CEILING_PCT,
} from "@/lib/earnings/implied-move";
import { refreshReportHistory } from "@/lib/earnings/report-history";
import { isHistoryStale } from "@/lib/queries/earnings-intel";
import { upsertEarningsIntel } from "@/lib/mutations/earnings-intel";
import { getSecurityIdForSymbolWithSiblings } from "@/lib/queries/briefing-symbols";
import { getSecurityQuote } from "@/lib/queries/security-quotes";
import { issuerSiblings } from "@/lib/securities/issuer-family";

export interface IntelEvent {
  id: number;
  symbol: string;
  event_date: string;
  event_time: string | null; // 'BMO' | 'AMC' | other/null
}

export const INTEL_TTL_MS = 30 * 60 * 1000;
export const AV_FETCH_CAP_PER_RUN = 5;

// In-process TTL so 60s cockpit polling costs at most one OAuth roundtrip per
// event per 30 min (macro-themes limiter pattern). forceFresh bypasses.
const lastComputedAt = new Map<number, number>();
export function __resetIntelTtlForTests(): void { lastComputedAt.clear(); }

interface IntelDeps {
  loadConfig: typeof loadIbkrConfig;
  openSession: (cfg: ReturnType<typeof loadIbkrConfig> & object) => Promise<unknown>;
  resolveChain: typeof resolveAtmContracts;
  snapshot: typeof getMarketDataSnapshot;
  refreshHistory: typeof refreshReportHistory;
  historyStale: typeof isHistoryStale;
  now: () => number;
}

const defaultDeps: IntelDeps = {
  loadConfig: loadIbkrConfig,
  openSession: openSession as never,
  resolveChain: resolveAtmContracts,
  snapshot: getMarketDataSnapshot,
  refreshHistory: refreshReportHistory,
  historyStale: isHistoryStale,
  now: Date.now,
};

function normalizeEventTime(t: string | null): "BMO" | "AMC" | null {
  return t === "BMO" || t === "AMC" ? t : null;
}

function latestSpot(db: Database.Database, securityId: number): number | null {
  const row = db.prepare(
    "SELECT close_price AS p FROM prices WHERE security_id = ? ORDER BY date DESC LIMIT 1"
  ).get(securityId) as { p: number } | undefined;
  return row?.p ?? null;
}

function conidFor(db: Database.Database, securityId: number): number | null {
  const row = db.prepare("SELECT ib_con_id AS c FROM securities WHERE id = ?")
    .get(securityId) as { c: number | null } | undefined;
  return row?.c ?? null;
}

function dteDays(fromMs: number, expiryIso: string): number {
  return Math.max(1, Math.round((Date.parse(`${expiryIso}T16:00:00Z`) - fromMs) / 86400_000));
}

export async function ensureIntelForEvents(
  db: Database.Database,
  events: IntelEvent[],
  opts: { forceFresh?: boolean } = {},
  deps: IntelDeps = defaultDeps,
): Promise<void> {
  if (events.length === 0) return;
  const nowMs = deps.now();

  // ── History refresh (family-deduped, AV-capped) ──────────────────────────
  try {
    const seenFamilies = new Set<string>();
    let avFetches = 0;
    for (const ev of events) {
      const famKey = issuerSiblings(ev.symbol).map((s) => s.toUpperCase()).sort().join("|");
      if (seenFamilies.has(famKey)) continue;
      seenFamilies.add(famKey);
      if (avFetches >= AV_FETCH_CAP_PER_RUN) break;
      try {
        if (deps.historyStale(db, ev.symbol)) {
          avFetches++;
          await deps.refreshHistory(db, ev.symbol);
        }
      } catch (e) {
        console.warn(`[earnings-intel] history refresh errored for ${ev.symbol}:`, e);
      }
    }
  } catch (e) {
    console.warn("[earnings-intel] history phase failed:", e);
  }

  // ── Implied move per event ───────────────────────────────────────────────
  let lst: string | null = null;
  let sessionTried = false;
  const cfg = (() => { try { return deps.loadConfig(); } catch { return null; } })();

  for (const ev of events) {
    try {
      if (!opts.forceFresh) {
        const last = lastComputedAt.get(ev.id);
        if (last != null && nowMs - last < INTEL_TTL_MS) continue;
      }

      const securityId = getSecurityIdForSymbolWithSiblings(db, ev.symbol);
      const spot = securityId != null ? latestSpot(db, securityId) : null;
      const eventTime = normalizeEventTime(ev.event_time);

      let impliedMovePct: number | null = null;
      let impliedMethod: "straddle" | "iv_approx" | null = null;
      let expiryUsed: string | null = null;
      let straddleMid: number | null = null;

      // Road 1: straddle via headless chain.
      const conid = securityId != null ? conidFor(db, securityId) : null;
      if (cfg && conid != null && spot != null) {
        try {
          if (lst == null && !sessionTried) {
            sessionTried = true;
            const sess = await deps.openSession(cfg);
            lst = typeof sess === "string" ? sess : ((sess as { lst?: string })?.lst ?? null);
          }
          if (lst != null) {
            const chain = await deps.resolveChain(cfg, lst, {
              conid, eventDate: ev.event_date, eventTime, spot,
            });
            if (chain) {
              const quotes = await deps.snapshot(cfg, lst, [chain.callConid, chain.putConid], {
                fields: [SNAPSHOT_FIELDS.LAST, SNAPSHOT_FIELDS.BID, SNAPSHOT_FIELDS.ASK],
              });
              const call = quotes.find((q) => q.conid === chain.callConid);
              const put = quotes.find((q) => q.conid === chain.putConid);
              const callMid = computeMid(call?.bid ?? null, call?.ask ?? null, call?.last ?? null);
              const putMid = computeMid(put?.bid ?? null, put?.ask ?? null, put?.last ?? null);
              const pct = straddleImpliedMovePct(callMid, putMid, spot);
              if (pct != null && pct <= IMPLIED_MOVE_CORRUPT_CEILING_PCT) {
                impliedMovePct = pct;
                impliedMethod = "straddle";
                expiryUsed = chain.expiry;
                straddleMid = (callMid ?? 0) + (putMid ?? 0);
              }
            }
          }
        } catch (e) {
          console.warn(`[earnings-intel] straddle road failed for ${ev.symbol}:`, e);
        }
      }

      // Road 2: IV approximation.
      if (impliedMethod == null && securityId != null) {
        const quote = getSecurityQuote(db, securityId);
        const iv = quote?.iv_underlying ?? null;
        const expiry = defaultExpiryFriday(ev.event_date);
        const pct = ivApproxMovePct(iv, dteDays(nowMs, expiry));
        if (pct != null) {
          impliedMovePct = pct;
          impliedMethod = "iv_approx";
          expiryUsed = expiry;
        }
      }

      upsertEarningsIntel(db, {
        eventId: ev.id, impliedMovePct, impliedMethod, expiryUsed, straddleMid, spot,
        computedAt: new Date(nowMs).toISOString().replace("T", " ").slice(0, 19),
      });
      lastComputedAt.set(ev.id, nowMs);
    } catch (e) {
      console.warn(`[earnings-intel] intel failed for event ${ev.id} (${ev.symbol}):`, e);
    }
  }
}
```

Note: check `getSecurityQuote`'s actual return field name for IV (`lib/queries/security-quotes.ts:8` `SecurityQuote` interface — adapt `iv_underlying` vs `ivUnderlying` to what's there).

- [ ] **Step 4: Run tests — verify pass**

Run: `npx vitest run tests/earnings/intel.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/earnings/intel.ts tests/earnings/intel.test.ts
git commit -m "feat(earnings-intel): ensureIntelForEvents orchestrator (TTL, AV cap, two-road implied move)"
```

---

### Task 7: Preview email integration (scoreboard rows + Past prints block + prompt + recap echo)

**Files:**
- Modify: `lib/digest/send-earnings-email.ts` (`renderHeadlineTable` ~line 1015, `buildPreviewContext` ~478, `renderPreviewPrompt` ~1093, recap prompt ~1174, the send path ~149-156, near `readReactionDelta` ~995)
- Modify: `app/api/earnings/email-content/route.ts`
- Test: `tests/digest/earnings-intel-render.test.ts`

**Interfaces:**
- Consumes: `getIntelForEvents`, `getReportHistoryForFamily` (Task 2), `summarizeHistory`, `HistorySummary` (Task 4), `ensureIntelForEvents` (Task 6).
- Produces:
  - `EarningsIntelView = { impliedMovePct: number | null; impliedMethod: "straddle" | "iv_approx" | null; expiryUsed: string | null; history: ReportHistoryRow[]; summary: HistorySummary }` (exported from `send-earnings-email.ts`)
  - `loadIntelView(db, eventId, symbol): EarningsIntelView` (exported — reused by the viewer route and Task 8's decorate)
  - `renderHeadlineTable(event, symbol, phase, intel?: EarningsIntelView | null)` — extended signature
  - `renderPastPrintsBlock(history: ReportHistoryRow[]): string` (exported; "" when empty)

- [ ] **Step 1: Write failing render tests**

```typescript
// tests/digest/earnings-intel-render.test.ts
import { describe, it, expect } from "vitest";
import {
  renderHeadlineTable, renderPastPrintsBlock, type EarningsIntelView,
} from "@/lib/digest/send-earnings-email";

const EVENT = {
  consensus_estimate: "EPS 1.35 · Rev 750M", actual_value: null,
  consensus_value: null, reaction_snapshot: null,
} as never;

const HISTORY = [
  { reportedDate: "2026-04-22", fiscalDateEnding: "2026-03-31", epsActual: 1.42, epsEstimate: 1.35, surprisePct: 5.19, reportTime: "post-market" as const, postPrintMovePct: 4.1 },
  { reportedDate: "2026-01-28", fiscalDateEnding: "2025-12-31", epsActual: 1.1, epsEstimate: 1.2, surprisePct: -8.3, reportTime: "pre-market" as const, postPrintMovePct: -2.3 },
];

const INTEL: EarningsIntelView = {
  impliedMovePct: 4.8, impliedMethod: "straddle", expiryUsed: "2026-07-18",
  history: HISTORY,
  summary: { avgAbsMovePct: 3.2, beatCount: 6, missCount: 2, quarterCount: 8 },
};

describe("scoreboard intel rows", () => {
  it("straddle row + history row on preview", () => {
    const md = renderHeadlineTable(EVENT, "TER", "preview", INTEL);
    expect(md).toContain("| **Expected move (options)** | ±4.8% (straddle, Jul 18 exp) | — | — |");
    expect(md).toContain("| **Avg move last 8 prints** | ±3.2% · beat 6/8 | — | — |");
  });
  it("IV-approx renders the ~ label", () => {
    const md = renderHeadlineTable(EVENT, "TER", "preview",
      { ...INTEL, impliedMethod: "iv_approx", impliedMovePct: 3.1 });
    expect(md).toContain("~±3.1% (IV approx)");
  });
  it("missing intel renders dashes and stays 8 rows", () => {
    const md = renderHeadlineTable(EVENT, "TER", "preview",
      { ...INTEL, impliedMovePct: null, impliedMethod: null, summary: { avgAbsMovePct: null, beatCount: 0, missCount: 0, quarterCount: 0 } });
    expect(md).toContain("| **Expected move (options)** | — | — | — |");
    expect(md).toContain("| **Avg move last 8 prints** | — | — | — |");
  });
  it("undefined intel (no cache at all) keeps rows with dashes", () => {
    const md = renderHeadlineTable(EVENT, "TER", "preview", null);
    expect(md).toContain("| **Expected move (options)** | — | — | — |");
  });
  it("recap echoes implied vs realized with inside/outside verdict", () => {
    const recapEvent = {
      ...EVENT, actual_value: "EPS 1.42 · Rev 775M",
      reaction_snapshot: JSON.stringify({ symbol: { pct: -7.2 }, spy: { pct: 0.2 }, qqq: { pct: 0.3 } }),
    } as never;
    const md = renderHeadlineTable(recapEvent, "TER", "recap", INTEL);
    expect(md).toContain("**Expected move (options)**");
    expect(md).toMatch(/±4\.8% \(straddle.*\|.*7\.2%.*\|.*outside/);
  });
});

describe("renderPastPrintsBlock", () => {
  it("renders one row per quarter, newest first", () => {
    const md = renderPastPrintsBlock(HISTORY);
    expect(md).toContain("## Past prints");
    expect(md).toContain("| 2026-04-22 | 1.42 / 1.35 | +5.2% | +4.1% |");
    expect(md).toContain("| 2026-01-28 | 1.10 / 1.20 | -8.3% | -2.3% |");
  });
  it("empty history → empty string", () => {
    expect(renderPastPrintsBlock([])).toBe("");
  });
});
```

NOTE on the recap-echo test: first READ `readReactionDelta` (`send-earnings-email.ts:995`) to learn the actual `reaction_snapshot` JSON shape it parses (the fixture above guesses `{symbol:{pct}}` — replace the fixture with the real shape, and reuse the same parsing for the numeric echo; add a small `readReactionPct(json, key): number | null` next to `readReactionDelta` that returns the raw number).

- [ ] **Step 2: Run tests — verify fail**

Run: `npx vitest run tests/digest/earnings-intel-render.test.ts`
Expected: FAIL (new exports missing).

- [ ] **Step 3: Implement in `lib/digest/send-earnings-email.ts`**

(a) New imports + types + loader:

```typescript
import { getIntelForEvents, getReportHistoryForFamily } from "@/lib/queries/earnings-intel";
import { summarizeHistory, type HistorySummary } from "@/lib/earnings/report-history";
import { ensureIntelForEvents } from "@/lib/earnings/intel";
import type { ReportHistoryRow } from "@/lib/mutations/earnings-intel";

export interface EarningsIntelView {
  impliedMovePct: number | null;
  impliedMethod: "straddle" | "iv_approx" | null;
  expiryUsed: string | null;
  history: ReportHistoryRow[];
  summary: HistorySummary;
}

export function loadIntelView(db: Database.Database, eventId: number, symbol: string): EarningsIntelView {
  const intel = getIntelForEvents(db, [eventId]).get(eventId) ?? null;
  const history = getReportHistoryForFamily(db, symbol, 8);
  return {
    impliedMovePct: intel?.impliedMovePct ?? null,
    impliedMethod: intel?.impliedMethod ?? null,
    expiryUsed: intel?.expiryUsed ?? null,
    history,
    summary: summarizeHistory(history),
  };
}
```

(b) Row formatting helpers + rows inside `renderHeadlineTable` (add optional 4th param `intel?: EarningsIntelView | null`). Insert the two rows into the `rows` array right after the Revenue row:

```typescript
function fmtExpiryShort(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(`${iso}T12:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function fmtImplied(intel: EarningsIntelView | null | undefined): string {
  if (!intel || intel.impliedMovePct == null || !intel.impliedMethod) return "—";
  const pct = intel.impliedMovePct.toFixed(1);
  return intel.impliedMethod === "straddle"
    ? `±${pct}% (straddle, ${fmtExpiryShort(intel.expiryUsed)} exp)`
    : `~±${pct}% (IV approx)`;
}

function fmtHistSummary(intel: EarningsIntelView | null | undefined): string {
  const s = intel?.summary;
  if (!s || s.avgAbsMovePct == null) return "—";
  const denom = s.beatCount + s.missCount;
  const beat = denom > 0 ? ` · beat ${s.beatCount}/${denom}` : "";
  return `±${s.avgAbsMovePct.toFixed(1)}%${beat}`;
}
```

In the `rows` array (preview: implied in the Consensus column, Actual/Δ dashes; recap: realized |move| in Actual, `inside`/`outside` in Δ):

```typescript
const impliedCell = fmtImplied(intel);
let impliedActual = "—";
let impliedVerdict = "—";
if (isRecap && intel?.impliedMovePct != null) {
  const realized = readReactionPct(event.reaction_snapshot, "symbol"); // new numeric sibling of readReactionDelta
  if (realized != null) {
    impliedActual = `${realized >= 0 ? "+" : ""}${realized.toFixed(1)}%`;
    impliedVerdict = Math.abs(realized) <= intel.impliedMovePct ? "inside" : "outside";
  }
}
const rows = [
  `| **EPS** | ${epsConsensus} | ${epsActual} | ${epsDelta} |`,
  `| **Revenue** | ${revConsensus} | ${revActual} | ${revDelta} |`,
  `| **Expected move (options)** | ${impliedCell} | ${impliedActual} | ${impliedVerdict} |`,
  `| **Avg move last 8 prints** | ${fmtHistSummary(intel)} | — | — |`,
  `| **Guidance (next quarter)** | — | — | — |`,
  // ... existing reaction rows unchanged
].join("\n");
```

(c) `renderPastPrintsBlock` (exported, deterministic, preview-only consumer):

```typescript
export function renderPastPrintsBlock(history: ReportHistoryRow[]): string {
  if (history.length === 0) return "";
  const sign = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
  const rows = history.map((h) => {
    const eps = h.epsActual != null && h.epsEstimate != null
      ? `${h.epsActual.toFixed(2)} / ${h.epsEstimate.toFixed(2)}`
      : h.epsActual != null ? h.epsActual.toFixed(2) : "—";
    const surprise = h.surprisePct != null ? sign(h.surprisePct) : "—";
    const move = h.postPrintMovePct != null ? sign(h.postPrintMovePct) : "—";
    return `| ${h.reportedDate} | ${eps} | ${surprise} | ${move} |`;
  });
  return `## Past prints

| Reported | EPS act / est | Surprise | Next-day move |
|---|---|---|---|
${rows.join("\n")}

*Next-day move is close-over-close around the print (public market data; history via Alpha Vantage).*`;
}
```

Match the exact surprise/EPS formatting the tests pin (`+5.2%` — `toFixed(1)`; `1.10 / 1.20` — `toFixed(2)`).

(d) Wiring: in `sendEarningsEmail`'s preview branch (before `buildPreviewContext` at ~149): `await ensureIntelForEvents(db, [{ id: event.id, symbol, event_date: event.event_date, event_time: event.event_time }], { forceFresh: true });` wrapped in try/catch (best-effort). Then `const intelView = loadIntelView(db, event.id, symbol);` — thread `intelView` into the `renderHeadlineTable` call and append `renderPastPrintsBlock(intelView.history)` to the deterministic email body right after the scoreboard (find where `headlineTable` is concatenated into the html/markdown at ~156 and append). Inject the same block text into the preview PROMPT: in `renderPreviewPrompt` (~1093), add `const pastPrintsBlock = renderPastPrintsBlock(ctx.intelHistory ?? []);` positioned after `bogeysBlock`, before `readThroughsBlock` — extend `PreviewContext` with `intel?: EarningsIntelView` (set in `buildPreviewContext` via `loadIntelView`) and use `ctx.intel`. Recap path: `loadIntelView` result passed to `renderHeadlineTable` only (no Past prints block, no recompute).

(e) Viewer route `app/api/earnings/email-content/route.ts`: it calls the exported `renderHeadlineTable(event, symbol, phase)` — add `loadIntelView(db, event.id, symbol)` and pass it, so the in-app viewer matches the sent email.

- [ ] **Step 4: Run tests — verify pass, plus existing suites**

Run: `npx vitest run tests/digest/earnings-intel-render.test.ts tests/digest/`
Expected: new tests PASS; existing scoreboard/prompt pins updated ONLY where they assert the full row list (the two new rows shift the table; update those pinned strings deliberately, never weaken assertions).

- [ ] **Step 5: Commit**

```bash
git add lib/digest/send-earnings-email.ts app/api/earnings/email-content/route.ts tests/digest/earnings-intel-render.test.ts tests/digest/
git commit -m "feat(earnings-intel): scoreboard implied/history rows + Past prints block + preview prompt context"
```

---

### Task 8: Cockpit integration

**Files:**
- Modify: `lib/queries/earnings-cockpit.ts` (CockpitRow type + null default)
- Modify: `lib/queries/earnings-intel.ts` (add `decorateCockpitIntel`)
- Modify: `app/api/earnings/cockpit/route.ts`
- Modify: `app/dashboard/today/EarningsCockpit.tsx` (row intel line + client type)
- Test: extend `tests/queries/earnings-intel.test.ts` (decorate) + `tests/contracts/api-component-contracts.test.ts` (payload shape)

**Interfaces:**
- Consumes: `CockpitPayload`/`CockpitRow` (`lib/queries/earnings-cockpit.ts:24-47`), `ensureIntelForEvents`, `getIntelForEvents`, `getReportHistoryForFamily`, `summarizeHistory`.
- Produces:
  - `CockpitRow.intel: CockpitIntel | null` where `CockpitIntel = { impliedMovePct: number | null; impliedMethod: "straddle" | "iv_approx" | null; histAvgAbsMovePct: number | null; histBeatCount: number; histQuarterCount: number }`
  - `decorateCockpitIntel(db, payload: CockpitPayload): void` (mutates rows in place; read-only DB access)
  - `cockpitRowsToIntelEvents(payload): IntelEvent[]` (exported from `lib/queries/earnings-intel.ts` for the route)

- [ ] **Step 1: Write failing tests**

Append to `tests/queries/earnings-intel.test.ts`:

```typescript
import { decorateCockpitIntel } from "@/lib/queries/earnings-intel";
import { upsertEarningsIntel as upsertIntel2 } from "@/lib/mutations/earnings-intel";

describe("decorateCockpitIntel", () => {
  it("attaches cached intel + history summary per row; null when absent", () => {
    const id = seedEvent();
    upsertIntel2(db, { eventId: id, impliedMovePct: 4.8, impliedMethod: "straddle",
      expiryUsed: "2026-07-18", straddleMid: 6.2, spot: 129.1, computedAt: "2026-07-14 14:05:00" });
    replaceReportHistory(db, "TER", [HIST()]);
    const payload = {
      lanes: {
        bmo: [], unknown: [],
        amc: [{ eventId: id, symbol: "TER", intel: null } as never],
      },
      carryover: [{ eventId: 999999, symbol: "ZZZ", intel: null } as never],
    } as never;
    decorateCockpitIntel(db, payload);
    const row = (payload as { lanes: { amc: Array<{ intel: unknown }> } }).lanes.amc[0];
    expect(row.intel).toMatchObject({ impliedMovePct: 4.8, impliedMethod: "straddle", histBeatCount: 1 });
    const missing = (payload as { carryover: Array<{ intel: unknown }> }).carryover[0];
    expect(missing.intel).toBeNull();
  });
});
```

And in `tests/contracts/api-component-contracts.test.ts`, extend the existing cockpit contract (find the `buildCockpitPayload` entry; follow its established assertion style) to assert `intel` is present (null allowed) on rows after decorate.

- [ ] **Step 2: Run — verify fail**

Run: `npx vitest run tests/queries/earnings-intel.test.ts`
Expected: FAIL (`decorateCockpitIntel` missing).

- [ ] **Step 3: Implement**

In `lib/queries/earnings-cockpit.ts`: add to `CockpitRow`:

```typescript
  /** Earnings-intel decoration (implied move + history summary) — populated
   *  by decorateCockpitIntel in the route, NOT by buildCockpitPayload (this
   *  query stays network-free). */
  intel: CockpitIntel | null;
```

with `export interface CockpitIntel { impliedMovePct: number | null; impliedMethod: "straddle" | "iv_approx" | null; histAvgAbsMovePct: number | null; histBeatCount: number; histQuarterCount: number }` and initialize `intel: null` where rows are constructed (~line 141 block).

In `lib/queries/earnings-intel.ts`:

```typescript
import { summarizeHistory } from "@/lib/earnings/report-history";
import type { CockpitPayload, CockpitIntel } from "@/lib/queries/earnings-cockpit";
import type { IntelEvent } from "@/lib/earnings/intel";

function allRows(payload: CockpitPayload) {
  return [...payload.lanes.bmo, ...payload.lanes.amc, ...payload.lanes.unknown, ...payload.carryover];
}

export function cockpitRowsToIntelEvents(payload: CockpitPayload): IntelEvent[] {
  return allRows(payload).map((r) => ({
    id: r.eventId, symbol: r.symbol, event_date: r.eventDate, event_time: r.eventTime,
  }));
}

export function decorateCockpitIntel(db: Database.Database, payload: CockpitPayload): void {
  const rows = allRows(payload);
  const intelMap = getIntelForEvents(db, rows.map((r) => r.eventId));
  for (const row of rows) {
    const intel = intelMap.get(row.eventId);
    const history = getReportHistoryForFamily(db, row.symbol, 8);
    if (!intel && history.length === 0) { row.intel = null; continue; }
    const s = summarizeHistory(history);
    row.intel = {
      impliedMovePct: intel?.impliedMovePct ?? null,
      impliedMethod: intel?.impliedMethod ?? null,
      histAvgAbsMovePct: s.avgAbsMovePct,
      histBeatCount: s.beatCount,
      histQuarterCount: s.quarterCount,
    } satisfies CockpitIntel;
  }
}
```

(If `cockpitRowsToIntelEvents`'s import of `IntelEvent` creates a cycle through `lib/earnings/intel.ts` → queries, inline the 4-field type instead — it's structural.)

Route `app/api/earnings/cockpit/route.ts`:

```typescript
import db from "@/lib/db";
import { buildCockpitPayload } from "@/lib/queries/earnings-cockpit";
import { decorateCockpitIntel, cockpitRowsToIntelEvents } from "@/lib/queries/earnings-intel";
import { ensureIntelForEvents } from "@/lib/earnings/intel";

export async function GET() {
  try {
    const payload = buildCockpitPayload(db);
    await ensureIntelForEvents(db, cockpitRowsToIntelEvents(payload)); // TTL-guarded, best-effort
    decorateCockpitIntel(db, payload);
    return Response.json({ success: true, data: payload });
  } catch (e) {
    // keep the route's existing error envelope — read the current file and preserve it
    return Response.json({ success: false, error: String(e) }, { status: 500 });
  }
}
```

(Match the file's existing import style for `db` and error envelope exactly — read it first.)

`app/dashboard/today/EarningsCockpit.tsx`: extend the client-side row type with `intel` (mirror `CockpitIntel`), and in the row JSX (inside the module-scope `Lane` component, after the `netExposure` `<Money>` span, ~line 232):

```tsx
{row.intel && (row.intel.impliedMovePct != null || row.intel.histAvgAbsMovePct != null) && (
  <span className="text-[12px] text-ink-dim whitespace-nowrap">
    {row.intel.impliedMovePct != null && (
      <>impl {row.intel.impliedMethod === "iv_approx" ? "~" : ""}±{row.intel.impliedMovePct.toFixed(1)}%</>
    )}
    {row.intel.impliedMovePct != null && row.intel.histAvgAbsMovePct != null && " · "}
    {row.intel.histAvgAbsMovePct != null && (
      <>hist ±{row.intel.histAvgAbsMovePct.toFixed(1)}%
        {row.intel.histBeatCount + (row.intel.histQuarterCount - row.intel.histBeatCount) > 0 &&
          row.intel.histQuarterCount > 0 && ` (${row.intel.histBeatCount}/${row.intel.histQuarterCount})`}
      </>
    )}
  </span>
)}
```

(Simplify the beat-fraction guard to `row.intel.histQuarterCount > 0` — the double condition above is illustrative; final code should read cleanly. Public market data → NO `<PrivateText>`/`<Pct>` masking. Do NOT define any new component inside `EarningsCockpit` or `Lane` bodies.)

- [ ] **Step 4: Run — verify pass**

Run: `npx vitest run tests/queries/earnings-intel.test.ts tests/queries/earnings-cockpit.test.ts tests/contracts/`
Expected: PASS (cockpit tests may need `intel: null` added to row fixtures — update them).

- [ ] **Step 5: Commit**

```bash
git add lib/queries/earnings-cockpit.ts lib/queries/earnings-intel.ts app/api/earnings/cockpit/route.ts app/dashboard/today/EarningsCockpit.tsx tests/
git commit -m "feat(earnings-intel): cockpit intel decoration + lane-row impl/hist line"
```

---

### Task 9: Snapshot v9 + Worker read-only rendering

**Files:**
- Modify: `scripts/snapshot-state-to-r2.ts` (schemaVersion 8→9 at lines 43 + 478; new fields)
- Modify: `workers/cron/src/state.ts` (snapshot interface — find where `earningsBogeys`/`watchlistSymbols` are declared)
- Modify: `workers/cron/src/fallback-earnings.ts` (`renderScoreboard` ~614 + Past prints + as-of)
- Test: `workers/cron/test/fallback-earnings.test.ts` (extend existing)

**Interfaces:**
- Consumes: Mac-side `summarizeHistory` output shape (Task 4), `earnings_intel` + `earnings_report_history` tables.
- Produces (snapshot v9, both optional for degradation):
  - `earningsIntel?: Array<{ eventId: number; sourceKey: string; impliedMovePct: number | null; impliedMethod: "straddle" | "iv_approx" | null; expiryUsed: string | null; computedAt: string }>`
  - `earningsHistory?: Record<string, { rows: Array<{ reportedDate: string; epsActual: number | null; epsEstimate: number | null; surprisePct: number | null; postPrintMovePct: number | null }>; summary: { avgAbsMovePct: number | null; beatCount: number; missCount: number; quarterCount: number } }>`

- [ ] **Step 1: Write failing Worker tests**

In `workers/cron/test/fallback-earnings.test.ts`, following the file's existing fixture style (read it first), add:

```typescript
describe("intel rows in cloud scoreboard", () => {
  it("renders implied + history rows with as-of label when snapshot carries v9 fields", () => {
    // build a snapshot fixture with earningsIntel + earningsHistory for the event under test
    const md = renderScoreboard(event, "preview", null, false, {
      intel: { eventId: event.id, sourceKey: event.source_key, impliedMovePct: 4.8,
               impliedMethod: "straddle", expiryUsed: "2026-07-18", computedAt: "2026-07-14 06:00:00" },
      history: { rows: [/* 2 rows */], summary: { avgAbsMovePct: 3.2, beatCount: 6, missCount: 2, quarterCount: 8 } },
    });
    expect(md).toContain("Expected move (options)");
    expect(md).toContain("±4.8%");
    expect(md).toContain("as of");
    expect(md).toContain("Avg move last 8 prints");
  });
  it("pre-v9 snapshot (fields absent) renders the classic scoreboard unchanged", () => {
    const md = renderScoreboard(event, "preview", null, false, undefined);
    expect(md).not.toContain("Expected move (options)");
  });
});
```

Adapt the exact `renderScoreboard` signature extension to the existing one at `fallback-earnings.ts:614` — pass intel as a new optional trailing param.

- [ ] **Step 2: Run — verify fail**

Run: `cd workers/cron && npx vitest run test/fallback-earnings.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Mac snapshot script (`scripts/snapshot-state-to-r2.ts`): bump BOTH the type literal (line 43) and the object literal (line 478) to `9`; add near the other earnings queries:

```typescript
// v9: earnings intelligence — implied move per upcoming event + per-symbol history.
const earningsIntel = db.prepare(
  `SELECT ei.event_id AS eventId, ce.source_key AS sourceKey,
          ei.implied_move_pct AS impliedMovePct, ei.implied_method AS impliedMethod,
          ei.expiry_used AS expiryUsed, ei.computed_at AS computedAt
   FROM earnings_intel ei JOIN calendar_events ce ON ce.id = ei.event_id
   WHERE ce.event_date >= ?`
).all(daysAgo(1));

const upcomingSymbols = db.prepare(
  `SELECT DISTINCT UPPER(COALESCE(ce.symbol, '')) AS s
   FROM calendar_events ce
   WHERE (ce.event_type = 'earnings' OR ce.source = 'finnhub')
     AND ce.event_date BETWEEN ? AND ?`
).all(daysAgo(1), daysAhead(14)) // reuse the script's existing date helpers; add daysAhead if absent
  .map((r: { s: string }) => r.s).filter(Boolean);

const earningsHistory: Record<string, unknown> = {};
for (const sym of upcomingSymbols) {
  const rows = getReportHistoryForFamily(db, sym, 8);
  if (rows.length === 0) continue;
  earningsHistory[sym] = {
    rows: rows.map((r) => ({
      reportedDate: r.reportedDate, epsActual: r.epsActual, epsEstimate: r.epsEstimate,
      surprisePct: r.surprisePct, postPrintMovePct: r.postPrintMovePct,
    })),
    summary: summarizeHistory(rows),
  };
}
```

(Check the script's actual column for the event symbol — `calendar_events.symbol` vs a join; mirror how the script already extracts earnings symbols for `earnings_emails` rows.) Add `earningsIntel` + `earningsHistory` to the snapshot object and its TS interface.

Worker: add the optional fields to the snapshot interface in `workers/cron/src/state.ts` (byte-shape matching the Mac's), then in `fallback-earnings.ts`:
- In the candidate scan / send path, look up `snapshot.earningsIntel?.find(i => i.eventId === e.id)` and `snapshot.earningsHistory?.[sym]`, thread into `renderScoreboard(event, phase, payload, implausible, intelCtx?)`.
- Render rows identical to the Mac's (`| **Expected move (options)** | ±4.8% (straddle, Jul 18 exp — as of Jul 14 06:00 ET) | — | — |` — the as-of suffix is the only divergence, formatted from `computedAt` via the file's existing ET helpers in `dst.ts`), plus the history row, both `—` when the ctx is absent — and a Past prints section from `history.rows` (hand-rolled small renderer in the Worker file; keep it below `renderScoreboard`).
- Pre-v9 degradation: `undefined` fields → render exactly what today's code renders (the first test's `not.toContain` pins it).

- [ ] **Step 4: Run Worker tests — verify pass**

Run: `cd workers/cron && npx vitest run`
Expected: PASS (all existing tests too).

- [ ] **Step 5: Commit**

```bash
git add scripts/snapshot-state-to-r2.ts workers/cron/src/state.ts workers/cron/src/fallback-earnings.ts workers/cron/test/fallback-earnings.test.ts
git commit -m "feat(earnings-intel): snapshot v9 intel/history carry + Worker read-only scoreboard rows"
```

---

### Task 10: Full verification + live E2E + docs

**Files:**
- Modify: `docs/plans/TODO.md` (mark #9/#10 shipped inside the intelligence-tier entry)
- Modify: `CLAUDE.md` (one convention bullet, see below)

- [ ] **Step 1: Full Mac suite**

Run: `npx vitest run`
Expected: ALL pass (3243 + new). Fix any regressions (most likely: scoreboard pin tests, cockpit fixtures needing `intel: null`).

- [ ] **Step 2: Worker suite + typecheck + build**

Run: `cd workers/cron && npx vitest run && cd ../.. && npx tsc --noEmit && npx next build`
Expected: clean. (`next build` may warn on `data/vanguard.db` collection — known issue, TS compile success is the gate.)

- [ ] **Step 3: Migration against live DB**

Run: `npx tsx -e "require('./lib/db').default"` — or the project's standard migration path (opening the db singleton runs migrations). Verify: `sqlite3 data/vanguard.db "SELECT name FROM sqlite_master WHERE name LIKE 'earnings_%';"` lists both new tables.

- [ ] **Step 4: Live E2E — history + straddle + preview dry-run**

```bash
# History refresh for a 7/14 bank (live AV + Yahoo):
npx tsx -e "
import('./lib/db.js').then(async ({ default: db }) => {
  const { refreshReportHistory } = await import('./lib/earnings/report-history.js');
  console.log(await refreshReportHistory(db, 'JPM'));
  console.log(db.prepare('SELECT * FROM earnings_report_history WHERE symbol=\\'JPM\\'').all());
});"
# Full intel for the 7/14 events (live IBKR chain — TWS not required):
# find event ids: sqlite3 data/vanguard.db "SELECT id, title FROM calendar_events WHERE event_date='2026-07-14' AND (event_type='earnings' OR source='finnhub');"
# then run ensureIntelForEvents via a tsx one-liner mirroring the above and inspect earnings_intel.
# Preview dry-run (renders full email without sending):
npx tsx scripts/fire-earnings-emails.ts preview 2026-07-14 --dry-run
```

Expected: `earnings_report_history` rows with plausible surprise/move numbers (sanity-check one JPM quarter against public record); `earnings_intel` row with `straddle` method and a single-digit implied move for a mega-bank; dry-run output shows the two scoreboard rows + Past prints block. If the straddle road fails live, diagnose against the probe script before touching code.

- [ ] **Step 5: Cockpit browser check**

With the dev server on :3000 (or the main session does this post-merge): `curl -s localhost:3000/api/earnings/cockpit | head -c 2000` shows `intel` on rows; then a browser look at `/dashboard/today` confirming the `impl ±X% · hist ±Y%` line renders and nothing overflows on mobile width. (agent-browser task in the main session per house E2E rule.)

- [ ] **Step 6: Docs + commit**

CLAUDE.md: add one bullet to the Conventions section:

```markdown
- **Earnings intelligence cache (migration 065)**: `earnings_intel` (per-event implied move; straddle via headless IBKR chain — `lib/ibkr/option-chain.ts`, params/field-codes pinned by `scripts/probe-ibkr-option-chain.ts`, NEVER edited from docs alone — with `iv_approx` fallback) + `earnings_report_history` (per-symbol AV surprise history + Yahoo next-day moves, 70d staleness, ≤12 quarters, family-aware reads). Single orchestrator `lib/earnings/intel.ts::ensureIntelForEvents` (30-min in-process TTL, AV cap 5/run, never throws — intel can never block a send); consumers: preview composer (forceFresh at T-2h), recap echo (read-only), cockpit route (`decorateCockpitIntel` — buildCockpitPayload itself stays network-free), snapshot v9 → Worker read-only rows with "as of". All figures public market data — plain formatters, never privacy-masked. Spec: `docs/superpowers/specs/2026-07-08-earnings-intelligence-design.md`.
```

TODO.md: inside the intelligence-tier entry, mark `#9`/`#10` as shipped with today's date (leave #11-13/#17-18 open).

```bash
git add CLAUDE.md docs/plans/TODO.md
git commit -m "docs(earnings-intel): conventions entry + TODO #9/#10 close-out"
```

---

## Self-review notes (run after drafting — resolved inline)

- Spec coverage: data model (T2), pure math + guards (T3), AV/Yahoo history (T4), chain+probe (T1/T5), orchestrator TTL/cap/best-effort (T6), email rows/block/prompt/recap/viewer (T7), cockpit route/decorate/UI (T8), snapshot v9 + Worker + degradation (T9), tests/E2E/docs (T10). Error-handling table: each row lands in T4/T5/T6/T7.
- Known judgment points for implementers: exact `reaction_snapshot` JSON shape (read `readReactionDelta` first — T7 note), `SecurityQuote` field casing (T6 note), `openSession` return shape (T1/T6 notes), snapshot script symbol extraction (T9 note). Each is a read-the-file-first instruction, not a guess.
- Type consistency: `ReportHistoryRow` defined once in `lib/mutations/earnings-intel.ts` and imported everywhere; `EarningsIntelView` defined once in `send-earnings-email.ts`; `CockpitIntel` defined once in `earnings-cockpit.ts`.
