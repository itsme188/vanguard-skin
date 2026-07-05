# Earnings Season Pre-Flight Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the July earnings-calendar coverage hole and fix the 6 verified bugs + 1 alerting gap that would cause duplicate, missing, or wrong earnings emails during earnings season (starts ~2026-07-14).

**Architecture:** All changes stay inside the existing enrichment-runner → sweep → composer pipeline. One new migration (062) adds two nullable columns to `calendar_events`. A new shared `runEarningsEmailSweep` in `lib/calendar/email-sweep.ts` becomes the single sweep implementation (route + tsx script), carrying the Mac↔cloud KV marker dance and the cross-process claim-row dedup. Enrichment switches from single-shot to retry-until-complete for earnings rows only (macro semantics unchanged).

**Tech Stack:** TypeScript 5, better-sqlite3 (DI: every DB function takes `db`), Vitest with `:memory:` DBs, Next.js 16 API routes.

**Source audit:** `docs/plans/2026-07-04-earnings-season-audit.md` (bug IDs B1–B9 referenced below).

## Global Constraints

- Every DB function takes a `db: Database.Database` parameter (in-memory test DBs).
- All dates `YYYY-MM-DD`; SQLite `datetime('now')` is UTC space-separated — wrap BOTH sides in `datetime()` when comparing, never raw-string-compare against ISO `T` strings.
- `release_time` is ET wall-clock — window math happens in JS via `composeReleaseInstant`, never SQL `datetime()` comparisons against it.
- Tests that touch AI/email paths must mock (`vi.mock`) the AI + `lib/email` modules — never depend on `.env.local` being loaded (memory: feedback_ai_test_mocking).
- Run `npx vitest run` (full suite, 1600+ tests) before each commit; do not commit on failures.
- Enrichment invariant: an enrichment pass may only ADD data, never clear it (COALESCE pattern).
- Do not touch macro-event enrichment semantics — earnings rows only.
- Never hardcode Claude model IDs; not applicable here but no new AI call sites should be added.

---

### Task 1: July calendar sync (data operation — time-critical)

There are ZERO earnings events in the DB for 2026-07-05 → 2026-07-19 (JPM/GS/BAC/NFLX/TSM week). No script currently drives `syncCalendarForWeek` from the CLI.

**Files:**
- Create: `scripts/sync-calendar-weeks.ts`

**Interfaces:**
- Consumes: `syncCalendarForWeek(db, weekOf, opts)` from `lib/calendar/sync.ts` (exists; validates weekOf is a Monday, auto-skips WSH without TWS and Finnhub without `FINNHUB_API_KEY`).
- Produces: nothing for later tasks (standalone ops script).

- [ ] **Step 1: Write the script**

```typescript
/**
 * Manually sync the calendar (macro + Finnhub earnings + Nasdaq cross-check)
 * for one or more weeks. Use when the automated Sunday sync hasn't covered a
 * week yet — e.g. the 2026-07 earnings-season ramp where weeks 07-06 and
 * 07-13 had zero events (audit: docs/plans/2026-07-04-earnings-season-audit.md).
 *
 * Usage:
 *   npx tsx scripts/sync-calendar-weeks.ts 2026-07-06 2026-07-13
 *
 * Each argument must be a Monday (validateWeekOf enforces this).
 * WSH (TWS) is skipped explicitly — this is a headless CLI path.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { db } from "../lib/db";
import { syncCalendarForWeek } from "../lib/calendar/sync";

async function main() {
  const weeks = process.argv.slice(2);
  if (weeks.length === 0) {
    console.error("Usage: npx tsx scripts/sync-calendar-weeks.ts <monday-YYYY-MM-DD> [...]");
    process.exit(1);
  }

  for (const weekOf of weeks) {
    console.log(`— syncing week ${weekOf}`);
    const result = await syncCalendarForWeek(db, weekOf, {
      includeWsh: false,
      onProgress: (e) => console.log(`  [${e.phase}] ${e.message}`),
    });
    console.log(
      `  finnhub ${result.finnhubEvents} (${result.finnhubNew} new) · ` +
        `nasdaq ${result.nasdaqEvents} (${result.nasdaqNew} new) · ` +
        `macro ${result.macroEvents} (${result.macroNew} new) · ` +
        `errors: ${result.errors.length ? result.errors.join("; ") : "none"}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run it for the two missing weeks**

Run: `cd /Users/Yitzi/code/vanguard-skin && npx tsx scripts/sync-calendar-weeks.ts 2026-07-06 2026-07-13`
Expected: per-phase progress lines; `finnhub N (M new)` with M > 0 for at least one week (bank earnings 7/14–7/17). Errors list should be "none" (Finnhub rate-limit warnings tolerable).

- [ ] **Step 3: Verify against the DB**

Run: `sqlite3 /Users/Yitzi/code/vanguard-skin/data/vanguard.db "SELECT event_date, symbol, source FROM calendar_events WHERE event_type='earnings' AND event_date BETWEEN '2026-07-05' AND '2026-07-19' ORDER BY event_date"`
Expected: rows exist; look for JPM/GS/BAC/BLK/NFLX/TSM-type held names. If a held name known to report that week is missing, note it in the task report (Finnhub sometimes lags on confirmations) — do not hand-insert events.

- [ ] **Step 4: Commit**

```bash
git add scripts/sync-calendar-weeks.ts
git commit -m "feat(calendar): CLI week-sync script + backfill July earnings weeks 07-06/07-13"
```

---

### Task 2: Fix 100× reaction inflation in recap prompt (B5)

`matchBarsToReaction` stores `delta_pct` already in percent (0.41 = 0.41%). `pctSign` in the composer multiplies by 100 again, so the Claude recap prompt reads "SPY: +41.00%" while the deterministic scoreboard in the same email is correct.

**Files:**
- Modify: `lib/digest/send-earnings-email.ts:844-847` (`pctSign`), and export `formatReactionSnapshot` (line 813) for testing
- Test: `tests/digest/reaction-snapshot-format.test.ts` (new)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `export function formatReactionSnapshot(json: string | null): string | null` (newly exported, same behavior).

- [ ] **Step 1: Write the failing test**

Check `tests/digest/earnings-prompt-no-dollar-leak.test.ts` first for any `vi.mock` setup it needs to import `send-earnings-email` safely; mirror that setup if present.

```typescript
import { describe, it, expect } from "vitest";
import { formatReactionSnapshot } from "../../lib/digest/send-earnings-email";

describe("formatReactionSnapshot", () => {
  it("renders delta_pct as-is (values are already percent), never ×100", () => {
    const json = JSON.stringify({
      t0_utc: "2026-07-22T20:15:00Z",
      window_min: 120,
      source: "yahoo",
      symbol: { symbol: "TER", delta_pct: 4.12 },
      spy: { delta_pct: 0.41 },
      qqq: { delta_pct: -0.28 },
    });
    const out = formatReactionSnapshot(json);
    expect(out).not.toBeNull();
    expect(out).toContain("TER: +4.12%");
    expect(out).toContain("SPY: +0.41%");
    expect(out).toContain("QQQ: -0.28%");
    expect(out).not.toContain("41.00%");
  });

  it("returns null for malformed json", () => {
    expect(formatReactionSnapshot("not json")).toBeNull();
    expect(formatReactionSnapshot(null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/digest/reaction-snapshot-format.test.ts`
Expected: FAIL — either import error (`formatReactionSnapshot` not exported) or assertion failure on "+412.00%".

- [ ] **Step 3: Fix**

In `lib/digest/send-earnings-email.ts`, change `function formatReactionSnapshot` → `export function formatReactionSnapshot` and:

```typescript
function pctSign(v: number): string {
  // delta_pct arrives already in percent (matchBarsToReaction multiplies by
  // 100 at capture time) — format as-is.
  const n = v.toFixed(2);
  return v >= 0 ? `+${n}%` : `${n}%`;
}
```

- [ ] **Step 4: Run test + full digest tests**

Run: `npx vitest run tests/digest/`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/digest/send-earnings-email.ts tests/digest/reaction-snapshot-format.test.ts
git commit -m "fix(earnings): recap prompt no longer inflates reaction pcts 100x (B5)"
```

---

### Task 3: Sync delete must not cascade user-curated earnings data (B4)

`deleteUnenrichedEventsForWeek` deletes every unenriched row for (week, source) on each sync; pre-release earnings rows are always unenriched, and `earnings_emails` / `earnings_email_skips` / `earnings_bogeys` all `ON DELETE CASCADE` — so a mid-week "Refresh from Finnhub" wipes skips, bogeys, and preview-sent audit rows, and reinserted rows get new ids that orphan KV markers.

**Files:**
- Modify: `lib/mutations/calendar.ts:352-367` (`deleteUnenrichedEventsForWeek`)
- Test: `tests/calendar/delete-preserves-children.test.ts` (new)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: same signature `deleteUnenrichedEventsForWeek(db, weekOf, source): number` — behavior narrows (rows with child records survive).

- [ ] **Step 1: Write the failing test**

Copy the in-memory DB setup (migration-runner bootstrap) from `tests/calendar/sync-preserves-enrichment.test.ts` — use the exact same helper it uses to create the schema.

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
// ⬇ use the same schema-bootstrap import that tests/calendar/sync-preserves-enrichment.test.ts uses
import { deleteUnenrichedEventsForWeek } from "../../lib/mutations/calendar";

function insertEvent(db: Database.Database, sourceKey: string): number {
  const r = db
    .prepare(
      `INSERT INTO calendar_events (source, source_key, event_type, event_date, week_of, title, symbol)
       VALUES ('finnhub', ?, 'earnings', '2026-07-28', '2026-07-27', 'T earnings', 'T')`,
    )
    .run(sourceKey);
  return Number(r.lastInsertRowid);
}

describe("deleteUnenrichedEventsForWeek preserves rows with children", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = /* same bootstrap as sync-preserves-enrichment.test.ts */;
  });

  it("keeps events that have an earnings_emails audit row", () => {
    const kept = insertEvent(db, "finnhub:KEEP:2026-07-28");
    const gone = insertEvent(db, "finnhub:GONE:2026-07-28");
    db.prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient) VALUES (?, 'preview', 'x@y.com')`,
    ).run(kept);

    const deleted = deleteUnenrichedEventsForWeek(db, "2026-07-27", "finnhub");

    expect(deleted).toBe(1);
    expect(db.prepare("SELECT id FROM calendar_events WHERE id = ?").get(kept)).toBeTruthy();
    expect(db.prepare("SELECT id FROM calendar_events WHERE id = ?").get(gone)).toBeUndefined();
  });

  it("keeps events that have a skip row", () => {
    const kept = insertEvent(db, "finnhub:SKIP:2026-07-28");
    db.prepare(
      `INSERT INTO earnings_email_skips (event_id, phase) VALUES (?, 'preview')`,
    ).run(kept);
    deleteUnenrichedEventsForWeek(db, "2026-07-27", "finnhub");
    expect(db.prepare("SELECT id FROM calendar_events WHERE id = ?").get(kept)).toBeTruthy();
  });

  it("keeps events that have a bogey row", () => {
    const kept = insertEvent(db, "finnhub:BOGEY:2026-07-28");
    db.prepare(
      `INSERT INTO earnings_bogeys (event_id, source, source_label, symbol) VALUES (?, 'manual', 'me', 'T')`,
    ).run(kept);
    deleteUnenrichedEventsForWeek(db, "2026-07-27", "finnhub");
    expect(db.prepare("SELECT id FROM calendar_events WHERE id = ?").get(kept)).toBeTruthy();
  });
});
```

NOTE: check `earnings_email_skips` (migration 045) and `earnings_bogeys` (migration 043) column NOT NULL requirements before finalizing the INSERT statements — adjust columns to satisfy the actual schema (e.g. bogeys may require `eps_consensus`-style fields to be nullable; read the migration files).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/calendar/delete-preserves-children.test.ts`
Expected: FAIL — the audited/skipped/bogeyed events get deleted (`deleted` = 2 in test 1; kept rows missing).

- [ ] **Step 3: Implement**

```typescript
export function deleteUnenrichedEventsForWeek(
  db: Database.Database,
  weekOf: string,
  source: CalendarEventSource
): number {
  // Rows referenced by earnings_emails / earnings_email_skips / earnings_bogeys
  // are user-curated state — deleting the parent CASCADEs them away and the
  // re-inserted row gets a new id that orphans KV markers + snapshot refs.
  // Sync may only replace rows nothing else points at.
  return db
    .prepare(
      `DELETE FROM calendar_events
        WHERE week_of = ? AND source = ?
          AND actual_value IS NULL
          AND consensus_value IS NULL
          AND reaction_snapshot IS NULL
          AND enriched_at IS NULL
          AND id NOT IN (SELECT event_id FROM earnings_emails)
          AND id NOT IN (SELECT event_id FROM earnings_email_skips)
          AND id NOT IN (SELECT event_id FROM earnings_bogeys)`
    )
    .run(weekOf, source).changes;
}
```

- [ ] **Step 4: Run calendar test suite**

Run: `npx vitest run tests/calendar/`
Expected: all PASS (including existing sync-preserves-enrichment tests).

- [ ] **Step 5: Commit**

```bash
git add lib/mutations/calendar.ts tests/calendar/delete-preserves-children.test.ts
git commit -m "fix(calendar): sync delete no longer cascades earnings emails/skips/bogeys (B4)"
```

---

### Task 4: Finnhub actuals foreign-suffix match (B6)

`fetchFinnhubActual` (`lib/calendar/enrich-actuals.ts:329`) exact-matches `e.symbol === symbol`, but Finnhub answers a `GFL` query with `symbol: "GFL.TO"` entries (already documented + fixed on the sync side at `lib/calendar/finnhub.ts:97-105`). Result: actuals permanently null for foreign-listed names → recap never fires.

**Files:**
- Modify: `lib/calendar/enrich-actuals.ts:329`
- Test: `tests/calendar/enrich-actuals.test.ts` (add case)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: no signature change.

- [ ] **Step 1: Write the failing test**

Read `tests/calendar/enrich-actuals.test.ts` and follow its existing fetch-mocking pattern (it stubs `global.fetch`). Add:

```typescript
it("matches Finnhub entries whose symbol carries a foreign-exchange suffix (GFL → GFL.TO)", async () => {
  // mock fetch to return the suffixed symbol for a GFL query
  globalThis.fetch = vi.fn(async () =>
    new Response(
      JSON.stringify({
        earningsCalendar: [
          {
            symbol: "GFL.TO",
            date: "2026-07-29",
            epsActual: 0.31,
            epsEstimate: 0.28,
            revenueActual: 2100000000,
            revenueEstimate: 2050000000,
          },
        ],
      }),
      { status: 200 },
    ),
  ) as unknown as typeof fetch;
  process.env.FINNHUB_API_KEY = "test-key";

  const result = await fetchActualForEvent(db, {
    // shape per existing tests in this file — source_key drives the dispatch
    source_key: "finnhub:GFL:2026-07-29",
    /* remaining fields copied from this file's existing earnings-event fixtures */
  });

  expect(result.actual).toContain("EPS 0.31");
});
```

Adapt the event-fixture shape and env handling to exactly match how the file's existing Finnhub tests do it (including afterEach fetch/env restore).

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/calendar/enrich-actuals.test.ts`
Expected: new case FAILS (`result.actual` is null — the `e.symbol === symbol` match misses).

- [ ] **Step 3: Implement**

In `fetchFinnhubActual`, replace the find line:

```typescript
  // The query is already symbol-scoped (?symbol=), so every returned entry
  // belongs to the queried issuer — but Finnhub may echo a foreign-exchange
  // suffix (query "GFL" → entries with symbol "GFL.TO"; same behavior
  // documented in lib/calendar/finnhub.ts). Match on date only; never
  // require the echoed symbol to equal the queried one.
  const entry = data.earningsCalendar?.find((e) => e.date === date);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/calendar/enrich-actuals.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/calendar/enrich-actuals.ts tests/calendar/enrich-actuals.test.ts
git commit -m "fix(earnings): Finnhub actuals match survives foreign-exchange symbol suffix (B6)"
```

---

### Task 5: Cloud-enrich reconcile must never clear data (B9)

`lib/calendar/cloud-reconcile.ts` does unconditional `SET actual_value = ?` / `reaction_snapshot = ?` and ignores `payload.deferred`. A deferred or failed cloud payload overwrites a real Mac-captured actual with NULL, and (with `enriched_at` then stamped) the row never retries. Task 6's retry semantics make this collision MORE likely, so this guard lands first.

**Files:**
- Modify: `lib/calendar/cloud-reconcile.ts:85-155`
- Test: `tests/calendar/cloud-reconcile.test.ts` (new)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `reconcileCloudEnrichment(db, secret)` signature unchanged; result gains `skipped_deferred: number` (additive — existing callers read `reconciled`/`skipped_tws_wins` only).

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import Database from "better-sqlite3";
// same schema bootstrap as other tests/calendar tests
import { reconcileCloudEnrichment } from "../../lib/calendar/cloud-reconcile";

function mockWorker(payloads: Record<string, unknown>) {
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "DELETE") return new Response("{}", { status: 200 });
    return new Response(JSON.stringify({ payloads }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("reconcileCloudEnrichment data-preservation guards", () => {
  let db: Database.Database;
  let eventId: number;

  beforeEach(() => {
    db = /* schema bootstrap */;
    process.env.WORKER_MARKER_URL = "https://worker.example.com";
    const r = db.prepare(
      `INSERT INTO calendar_events (source, source_key, event_type, event_date, week_of, title, symbol, actual_value, enriched_at)
       VALUES ('finnhub', 'finnhub:T:2026-07-28', 'earnings', '2026-07-28', '2026-07-27', 'T', 'T', 'EPS 1.42 · Rev 775,000,000', datetime('now'))`,
    ).run();
    eventId = Number(r.lastInsertRowid);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.WORKER_MARKER_URL;
  });

  it("skips deferred payloads entirely", async () => {
    mockWorker({
      [String(eventId)]: {
        eventId, source_key: "finnhub:T:2026-07-28",
        actual: null, consensus: null, source: "cloud",
        deferred: true, reaction: null, fetchedAt: "2026-07-28T21:00:00Z",
      },
    });
    const res = await reconcileCloudEnrichment(db, "secret");
    expect(res.skipped_deferred).toBe(1);
    const row = db.prepare("SELECT actual_value FROM calendar_events WHERE id = ?").get(eventId) as { actual_value: string };
    expect(row.actual_value).toBe("EPS 1.42 · Rev 775,000,000");
  });

  it("null actual in payload never clears an existing actual", async () => {
    mockWorker({
      [String(eventId)]: {
        eventId, source_key: "finnhub:T:2026-07-28",
        actual: null, consensus: null, source: "cloud",
        reaction: { source: "yahoo", spy: { delta_pct: 0.4 } }, fetchedAt: "2026-07-28T21:00:00Z",
      },
    });
    await reconcileCloudEnrichment(db, "secret");
    const row = db.prepare("SELECT actual_value, reaction_snapshot FROM calendar_events WHERE id = ?").get(eventId) as { actual_value: string; reaction_snapshot: string | null };
    expect(row.actual_value).toBe("EPS 1.42 · Rev 775,000,000"); // preserved
    expect(row.reaction_snapshot).toContain("yahoo"); // reaction still added
  });

  it("reaction-only payload on a row with no actual does NOT stamp enriched_at", async () => {
    const r2 = db.prepare(
      `INSERT INTO calendar_events (source, source_key, event_type, event_date, week_of, title, symbol)
       VALUES ('finnhub', 'finnhub:U:2026-07-28', 'earnings', '2026-07-28', '2026-07-27', 'U', 'U')`,
    ).run();
    const id2 = Number(r2.lastInsertRowid);
    mockWorker({
      [String(id2)]: {
        eventId: id2, source_key: "finnhub:U:2026-07-28",
        actual: null, consensus: null, source: "cloud",
        reaction: { source: "yahoo", spy: { delta_pct: 0.4 } }, fetchedAt: "2026-07-28T21:00:00Z",
      },
    });
    await reconcileCloudEnrichment(db, "secret");
    const row = db.prepare("SELECT enriched_at, reaction_snapshot FROM calendar_events WHERE id = ?").get(id2) as { enriched_at: string | null; reaction_snapshot: string | null };
    expect(row.reaction_snapshot).toContain("yahoo");
    expect(row.enriched_at).toBeNull(); // Mac retry (Task 6) can still fetch the actual
  });
});
```

- [ ] **Step 2: Run to verify failures**

Run: `npx vitest run tests/calendar/cloud-reconcile.test.ts`
Expected: FAIL — actual cleared to null / `skipped_deferred` undefined / enriched_at stamped.

- [ ] **Step 3: Implement**

In `lib/calendar/cloud-reconcile.ts`:

1. Add `skipped_deferred: number` to `CloudReconcileResult` and initialize `let skippedDeferred = 0;`. Include it in every return object (0 for the early-return paths).
2. Add `actual_value` to `selectRow`'s SELECT list and its row type.
3. Replace the two prepared statements:

```typescript
  const updateWithReaction = db.prepare(
    `UPDATE calendar_events
     SET actual_value = COALESCE(?, actual_value),
         consensus_value = COALESCE(consensus_value, ?),
         reaction_snapshot = COALESCE(?, reaction_snapshot),
         enriched_at = COALESCE(enriched_at, datetime('now'))
     WHERE id = ?`,
  );
  const updateActualOnly = db.prepare(
    `UPDATE calendar_events
     SET actual_value = COALESCE(?, actual_value),
         consensus_value = COALESCE(consensus_value, ?),
         enriched_at = COALESCE(enriched_at, datetime('now'))
     WHERE id = ?`,
  );
  // Reaction arrived but neither the payload nor the row has an actual yet:
  // store the reaction, leave enriched_at NULL so the Mac's enrichment
  // retry loop can still fetch the actual (Task 6 semantics).
  const updateReactionNoStamp = db.prepare(
    `UPDATE calendar_events
     SET reaction_snapshot = COALESCE(?, reaction_snapshot),
         consensus_value = COALESCE(consensus_value, ?)
     WHERE id = ?`,
  );
```

4. In the loop, before the TWS check:

```typescript
      if (payload.deferred) {
        // "deferred" = the Worker explicitly punted this event to the Mac
        // (e.g. nonfred Claude fetches). Nothing to apply — drain the key.
        await deleteFromWorker(base, secret, eventId);
        skippedDeferred += 1;
        continue;
      }
      if (payload.actual == null && payload.consensus == null && payload.reaction == null) {
        // Empty payload — nothing to add. Drain so it doesn't re-reconcile forever.
        await deleteFromWorker(base, secret, eventId);
        skippedDeferred += 1;
        continue;
      }
```

5. Replace the write branch:

```typescript
      const rowHasOrGetsActual = payload.actual != null || existing.actual_value != null;
      if (existingIsTws) {
        updateActualOnly.run(payload.actual, payload.consensus, eventId);
        skippedTwsWins += 1;
      } else if (rowHasOrGetsActual) {
        updateWithReaction.run(
          payload.actual,
          payload.consensus,
          payload.reaction ? JSON.stringify(payload.reaction) : null,
          eventId,
        );
      } else {
        updateReactionNoStamp.run(
          payload.reaction ? JSON.stringify(payload.reaction) : null,
          payload.consensus,
          eventId,
        );
      }
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/calendar/cloud-reconcile.test.ts tests/calendar/`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/calendar/cloud-reconcile.ts tests/calendar/cloud-reconcile.test.ts
git commit -m "fix(calendar): cloud reconcile only ADDs data — deferred/null payloads can no longer clear actuals (B9)"
```

---

### Task 6: Enrichment retry-until-complete for earnings (B2) — migration 062

Single-shot `enriched_at` stamping killed 10 recaps + all TWS-window reactions last season. Earnings rows now retry every tick (10-min pacing) until "complete": actual captured AND (reaction captured OR release ≥150 min ago). Macro rows keep single-shot semantics exactly.

**Files:**
- Create: `lib/db/migrations/062_enrichment_retry.sql`
- Modify: `lib/calendar/enrichment-runner.ts` (`EnrichmentCandidate`, `findCandidates`, `updateEnrichment`, `runEnrichment`)
- Test: `tests/calendar/enrichment-runner.test.ts` (add cases)

**Interfaces:**
- Consumes: nothing from other tasks (Task 5's guard protects against cloud collisions).
- Produces: `calendar_events.enrichment_attempted_at TEXT` + `calendar_events.actual_missing_alerted_at TEXT` columns (Task 9 consumes the latter). `runEnrichment` signature unchanged.

- [ ] **Step 1: Write the migration**

`lib/db/migrations/062_enrichment_retry.sql`:

```sql
-- Earnings enrichment retry semantics (2026-07-04 pre-season fixes, B2).
--
-- enrichment_attempted_at: stamped on EVERY enrichment attempt. For earnings
-- rows, enriched_at is now stamped only when enrichment is COMPLETE (actual
-- captured AND (reaction captured OR release >= 150 min ago)), so the runner
-- retries across ticks instead of burning its one shot 5-20 min post-release
-- before Finnhub has posted actuals / before reaction bars exist.
--
-- actual_missing_alerted_at: dedup stamp for the blocked-recap Pushover alert
-- (a previewed event sitting >2h post-release with no actual).
ALTER TABLE calendar_events ADD COLUMN enrichment_attempted_at TEXT;
ALTER TABLE calendar_events ADD COLUMN actual_missing_alerted_at TEXT;
```

- [ ] **Step 2: Write the failing tests**

Read `tests/calendar/enrichment-runner.test.ts` first; reuse its DB bootstrap, its `opts.now` injection, and its mocking approach for `fetchActualForEvent` / reaction capture (it uses `vi.mock` on `./enrich-actuals` and the reaction modules — follow the file's exact pattern). Add:

```typescript
describe("earnings retry-until-complete (migration 062)", () => {
  it("does NOT stamp enriched_at when the actual fetch returns null", async () => {
    // earnings row released 20 min ago; fetchActualForEvent mock → { actual: null, consensus: null }
    // reaction mocks → null
    await runEnrichment(db, { now: releasePlus(20) });
    const row = getRow();
    expect(row.enriched_at).toBeNull();
    expect(row.enrichment_attempted_at).not.toBeNull();
  });

  it("retries on a later tick and completes once actual + reaction exist", async () => {
    // attempt 1 at T+20: nulls → incomplete
    await runEnrichment(db, { now: releasePlus(20) });
    // attempt 2 at T+155: actual + reaction available → complete
    // (re-point the mocks to return real values)
    await runEnrichment(db, { now: releasePlus(155) });
    const row = getRow();
    expect(row.actual_value).toContain("EPS");
    expect(row.enriched_at).not.toBeNull();
  });

  it("actual present but no reaction: incomplete before 150 min, complete after", async () => {
    // actual mock returns a value, reaction mocks return null
    await runEnrichment(db, { now: releasePlus(20) });
    expect(getRow().enriched_at).toBeNull();          // has actual, waiting on reaction window
    expect(getRow().actual_value).toContain("EPS");   // but the actual was stored (COALESCE)
    await runEnrichment(db, { now: releasePlus(151) });
    expect(getRow().enriched_at).not.toBeNull();      // settle deadline passed
  });

  it("paces retries: a row attempted <10 min ago is not re-selected", async () => {
    await runEnrichment(db, { now: releasePlus(20) });
    const firstAttempt = getRow().enrichment_attempted_at;
    await runEnrichment(db, { now: releasePlus(25) }); // 5 min later
    expect(getRow().enrichment_attempted_at).toBe(firstAttempt); // unchanged
  });

  it("macro rows keep single-shot semantics (enriched_at stamped even on null actual)", async () => {
    // fred-source row, actual mock → null
    await runEnrichment(db, { now: macroReleasePlus(20) });
    expect(getMacroRow().enriched_at).not.toBeNull();
  });
});
```

Implement `releasePlus`/`getRow` helpers in the style the file already uses. IMPORTANT pacing-test caveat: `enrichment_attempted_at` is written with SQLite `datetime('now')` (real wall-clock), while `opts.now` is injected — for the pacing test, write `enrichment_attempted_at` directly via SQL (`datetime('now')`) and use a real-clock-relative `now` so the two clocks agree, or restructure to set the column manually. Whichever approach, both sides of the pacing comparison must come from the same clock.

- [ ] **Step 3: Run to verify failures**

Run: `npx vitest run tests/calendar/enrichment-runner.test.ts`
Expected: new cases FAIL (enriched_at stamped on first null attempt today).

- [ ] **Step 4: Implement**

In `lib/calendar/enrichment-runner.ts`:

1. Constants (near `MIN_AGE_MS`):

```typescript
// Earnings rows retry across ticks until complete. Pace retries so
// overlapping invocations (route + script) don't hammer Finnhub/Yahoo.
const RETRY_PACING_MS = 10 * 60 * 1000;
// After this long past release, an actual-bearing earnings row counts as
// complete even without a reaction snapshot (bars target T+120; +30 slack).
const REACTION_SETTLE_MS = 150 * 60 * 1000;
```

2. `EnrichmentCandidate`: add `actual_value: string | null; reaction_snapshot: string | null; enrichment_attempted_at: string | null;` and add the three columns to BOTH SELECTs in `findCandidates` (the eventId path and the window path) and the one in `runTwsReactionUpgrade`.

3. In `findCandidates`'s JS filter loop, add pacing (after the age check):

```typescript
    if (ageMs >= MIN_AGE_MS && ageMs <= maxAge) {
      if (row.enrichment_attempted_at) {
        // datetime('now') format: "YYYY-MM-DD HH:MM:SS" (UTC).
        const attemptedMs = Date.parse(row.enrichment_attempted_at.replace(" ", "T") + "Z");
        if (Number.isFinite(attemptedMs) && nowMs - attemptedMs < RETRY_PACING_MS) continue;
      }
      filtered.push(row);
      if (filtered.length >= limit) break;
    }
```

4. Replace `updateEnrichment`:

```typescript
// COALESCE on all three payload columns: an enrichment pass may only ADD
// data, never clear it (see original comment re deep-QA 2026-06-10).
// enriched_at is stamped only when the pass is COMPLETE (bound ?4 = 1);
// earnings rows retry across ticks until then. enrichment_attempted_at is
// stamped every pass — it drives retry pacing in findCandidates.
const updateEnrichment = (db: Database.Database) =>
  db.prepare(
    `UPDATE calendar_events
     SET actual_value = COALESCE(?, actual_value),
         consensus_value = COALESCE(?, consensus_value),
         reaction_snapshot = COALESCE(?, reaction_snapshot),
         enrichment_attempted_at = datetime('now'),
         enriched_at = CASE WHEN ? THEN COALESCE(enriched_at, datetime('now'))
                            ELSE enriched_at END
     WHERE id = ?`,
  );
```

5. In `runEnrichment`'s loop:
   - Skip the redundant actual re-fetch when the row already stored one:

```typescript
      const actualResult = event.actual_value
        ? { actual: null, consensus: null } // already captured on a prior attempt
        : await fetchActualForEvent(db, event);
```

   - Compute completeness before the `update.run(...)`:

```typescript
      const isEarnings =
        event.source === "finnhub" || event.event_type === "earnings";
      const releaseInstantForAge =
        event.release_time
          ? composeReleaseInstant(event.event_date, event.release_time)
          : null;
      const ageMs = releaseInstantForAge
        ? (opts.now ?? new Date()).getTime() - releaseInstantForAge.getTime()
        : Number.POSITIVE_INFINITY;
      const hasActual = actualResult.actual != null || event.actual_value != null;
      const hasReaction = reaction != null || event.reaction_snapshot != null;
      // Macro rows keep single-shot semantics (complete on first attempt);
      // earnings rows complete only when the actual landed AND the reaction
      // either landed or its capture window has settled.
      const complete = !isEarnings
        ? true
        : hasActual && (hasReaction || ageMs >= REACTION_SETTLE_MS);
```

   - Change the update call: `update.run(actualResult.actual, actualResult.consensus, reaction ? JSON.stringify(reaction) : null, complete ? 1 : 0, event.id);`
   - In the `results.push`, set `enriched: complete` (a truthful per-pass report).

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/calendar/`
Expected: all PASS, including the pre-existing enrichment-runner cases (some may assert the old always-stamp behavior for earnings — update ONLY those assertions that encode the old bug, and say so in the task report).

- [ ] **Step 6: Apply the migration to the live DB**

Run: `npx tsx -e "import {config} from 'dotenv'; config({path:'.env.local'}); import('./lib/db').then(m => console.log('migrated'))"`
(Importing `lib/db` runs pending migrations via the existing runner — verify with:)
Run: `sqlite3 data/vanguard.db "SELECT name FROM pragma_table_info('calendar_events') WHERE name LIKE 'enrichment%' OR name LIKE 'actual_missing%'"`
Expected: both columns listed.

- [ ] **Step 7: Commit**

```bash
git add lib/db/migrations/062_enrichment_retry.sql lib/calendar/enrichment-runner.ts tests/calendar/enrichment-runner.test.ts
git commit -m "fix(earnings): enrichment retries until actual+reaction complete — no more single-shot recap kills (B2)"
```

---

### Task 7: Shared sweep with Mac↔cloud marker dance (B1)

The sweep route sends in-process with NO marker dance (the dance lives only in per-event routes nothing calls), so Mac + Worker double-send previews whenever the Mac is awake. Extract one shared sweep function that does the dance; use it from the route AND the tsx fallback script; delete dead `runEmailSweep`.

**Files:**
- Create: `lib/calendar/email-sweep.ts`
- Modify: `app/api/cron/earnings-sweep/route.ts` (thin wrapper), `scripts/sweep-earnings-emails.ts` (use shared fn), `lib/calendar/enrichment-runner.ts` (delete `runEmailSweep` + `EmailSweepResult`, lines 550-607 — zero external references, verified 2026-07-04)
- Test: `tests/calendar/email-sweep.test.ts` (new)

**Interfaces:**
- Consumes: `findEmailCandidates(db, opts)`, `sendEarningsPreview/sendEarningsRecap` (existing), marker helpers from `lib/cron/earnings-marker-check.ts` (existing, no-op when `WORKER_MARKER_URL` unset).
- Produces:

```typescript
export interface SweepCandidateResult {
  eventId: number;
  symbol: string;
  phase: "preview" | "recap";
  ok: boolean;
  skipped?: "cloud-already-sent";
  status?: number;
  message?: string;
  durationMs: number;
}
export interface SweepSummary {
  swept: number;
  sent: number;
  skipped: number;
  failed: number;
  results: SweepCandidateResult[];
}
export async function runEarningsEmailSweep(
  db: Database.Database,
  opts?: EmailSweepOpts,
): Promise<SweepSummary>;
```

(Task 8 later inserts a stale-claim cleanup at the top of this function; Task 9 appends the blocked-recap alert to it.)

- [ ] **Step 1: Write the failing tests**

`tests/calendar/email-sweep.test.ts` — mock the send + marker modules:

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";

const sendPreview = vi.fn(async () => ({ success: true }));
const sendRecap = vi.fn(async () => ({ success: true }));
vi.mock("@/lib/digest/send-earnings-email", () => ({
  sendEarningsPreview: (...a: unknown[]) => sendPreview(...a),
  sendEarningsRecap: (...a: unknown[]) => sendRecap(...a),
  EarningsEmailError: class extends Error { status = 500; },
}));

const checkMarker = vi.fn(async () => null as { sentBy: string } | null);
const setRunning = vi.fn(async () => null);
const clearRunning = vi.fn(async () => null);
const writeSent = vi.fn(async () => null);
vi.mock("@/lib/cron/earnings-marker-check", () => ({
  checkEarningsCloudMarker: (...a: unknown[]) => checkMarker(...a),
  setEarningsRunningMarker: (...a: unknown[]) => setRunning(...a),
  clearEarningsRunningMarker: (...a: unknown[]) => clearRunning(...a),
  writeMacSentEarningsMarker: (...a: unknown[]) => writeSent(...a),
}));

import { runEarningsEmailSweep } from "../../lib/calendar/email-sweep";

// DB bootstrap: schema via migrations + one held-symbol preview candidate.
// Build the candidate exactly the way tests/calendar/findEmailCandidates-skip.test.ts
// builds one (held security + holdings row + earnings event with release_time
// 120 min from `now`), and pass the same `now` into runEarningsEmailSweep.

describe("runEarningsEmailSweep marker dance", () => {
  it("checks cloud marker, sets running, sends, writes mac-sent, clears running", async () => {
    const summary = await runEarningsEmailSweep(db, { now });
    expect(summary.sent).toBe(1);
    expect(checkMarker).toHaveBeenCalledWith("preview", expect.any(Number));
    expect(setRunning).toHaveBeenCalled();
    expect(sendPreview).toHaveBeenCalledTimes(1);
    expect(writeSent).toHaveBeenCalled();
    expect(clearRunning).toHaveBeenCalled();
  });

  it("skips the send when the cloud already delivered, and records a local audit row", async () => {
    checkMarker.mockResolvedValueOnce({ sentBy: "cloud" });
    const summary = await runEarningsEmailSweep(db, { now });
    expect(summary.skipped).toBe(1);
    expect(sendPreview).not.toHaveBeenCalled();
    const audit = db
      .prepare("SELECT error FROM earnings_emails WHERE phase = 'preview'")
      .get() as { error: string } | undefined;
    expect(audit?.error).toBe("sent-by-cloud");
  });

  it("clears the running marker even when the send throws", async () => {
    sendPreview.mockRejectedValueOnce(new Error("boom"));
    const summary = await runEarningsEmailSweep(db, { now });
    expect(summary.failed).toBe(1);
    expect(clearRunning).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/calendar/email-sweep.test.ts`
Expected: FAIL — module `lib/calendar/email-sweep.ts` does not exist.

- [ ] **Step 3: Implement `lib/calendar/email-sweep.ts`**

```typescript
/**
 * Single shared earnings email sweep — used by BOTH the cron route
 * (/api/cron/earnings-sweep) and the launchd tsx fallback
 * (scripts/sweep-earnings-emails.ts).
 *
 * Carries the Phase-4 Mac↔cloud KV marker dance that previously lived only
 * in the (uncalled) per-event routes /api/cron/earnings-{preview,recap} —
 * without it, the Worker fallback and the Mac sweep double-sent every
 * preview whenever the Mac was awake (audit 2026-07-04, bug B1). Marker
 * helpers no-op gracefully when WORKER_MARKER_URL is unset.
 */

import type Database from "better-sqlite3";
import {
  findEmailCandidates,
  type EmailSweepOpts,
} from "./enrichment-runner";
import {
  sendEarningsPreview,
  sendEarningsRecap,
  EarningsEmailError,
} from "@/lib/digest/send-earnings-email";
import {
  checkEarningsCloudMarker,
  setEarningsRunningMarker,
  clearEarningsRunningMarker,
  writeMacSentEarningsMarker,
} from "@/lib/cron/earnings-marker-check";

export interface SweepCandidateResult {
  eventId: number;
  symbol: string;
  phase: "preview" | "recap";
  ok: boolean;
  skipped?: "cloud-already-sent";
  status?: number;
  message?: string;
  durationMs: number;
}

export interface SweepSummary {
  swept: number;
  sent: number;
  skipped: number;
  failed: number;
  results: SweepCandidateResult[];
}

/**
 * When the Worker fallback already delivered an email, mirror that fact into
 * the local audit table so (a) findEmailCandidates stops re-selecting the
 * event every tick and (b) the EarningsHub chips show it as sent.
 * ai_output_md stays NULL — the viewer knows there's no local copy.
 */
function recordCloudSentAudit(
  db: Database.Database,
  eventId: number,
  phase: "preview" | "recap",
): void {
  db.prepare(
    `INSERT INTO earnings_emails (event_id, phase, recipient, ai_output_md, error)
     VALUES (?, ?, 'cloud-fallback', NULL, 'sent-by-cloud')
     ON CONFLICT(event_id, phase) DO NOTHING`,
  ).run(eventId, phase);
}

export async function runEarningsEmailSweep(
  db: Database.Database,
  opts: EmailSweepOpts = {},
): Promise<SweepSummary> {
  const candidates = findEmailCandidates(db, opts);
  const results: SweepCandidateResult[] = [];

  for (const cand of candidates) {
    const t0 = Date.now();

    const cloudMarker = await checkEarningsCloudMarker(cand.phase, cand.eventId);
    if (cloudMarker?.sentBy === "cloud") {
      recordCloudSentAudit(db, cand.eventId, cand.phase);
      results.push({
        eventId: cand.eventId,
        symbol: cand.symbol,
        phase: cand.phase,
        ok: true,
        skipped: "cloud-already-sent",
        durationMs: Date.now() - t0,
      });
      continue;
    }

    void setEarningsRunningMarker(cand.phase, cand.eventId);
    try {
      if (cand.phase === "preview") {
        await sendEarningsPreview(db, cand.eventId);
      } else {
        await sendEarningsRecap(db, cand.eventId);
      }
      void writeMacSentEarningsMarker(cand.phase, cand.eventId);
      results.push({
        eventId: cand.eventId,
        symbol: cand.symbol,
        phase: cand.phase,
        ok: true,
        durationMs: Date.now() - t0,
      });
    } catch (err) {
      const status = err instanceof EarningsEmailError ? err.status : 500;
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        eventId: cand.eventId,
        symbol: cand.symbol,
        phase: cand.phase,
        ok: false,
        status,
        message,
        durationMs: Date.now() - t0,
      });
    } finally {
      void clearEarningsRunningMarker(cand.phase, cand.eventId);
    }
  }

  return {
    swept: candidates.length,
    sent: results.filter((r) => r.ok && !r.skipped).length,
    skipped: results.filter((r) => r.skipped).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
}
```

- [ ] **Step 4: Rewire the route**

`app/api/cron/earnings-sweep/route.ts` becomes:

```typescript
import { db } from "@/lib/db";
import { runEarningsEmailSweep } from "@/lib/calendar/email-sweep";
import { withCronAuth } from "@/lib/cron/wrappers";

export const dynamic = "force-dynamic";

/**
 * POST /api/cron/earnings-sweep — Top-level Phase-3 driver.
 *
 * Auth: X-Cron-Secret. No body. Called every 15 min by
 * scripts/enrich-calendar-events.sh after the enrich call.
 *
 * Delegates to runEarningsEmailSweep (lib/calendar/email-sweep.ts), which
 * carries the Mac↔cloud marker dance + candidate windows. The composer's
 * audit row remains the local dedup floor.
 */
export async function POST(request: Request) {
  return withCronAuth(request, async () => runEarningsEmailSweep(db));
}
```

- [ ] **Step 5: Rewire the tsx fallback script**

`scripts/sweep-earnings-emails.ts` main body becomes:

```typescript
import { config } from "dotenv";
config({ path: ".env.local" });

import { db } from "../lib/db";
import { runEarningsEmailSweep } from "../lib/calendar/email-sweep";

async function main() {
  const summary = await runEarningsEmailSweep(db);
  if (summary.swept === 0) {
    console.log(`${new Date().toISOString()} — no email candidates`);
    return;
  }
  for (const r of summary.results) {
    const dt = (r.durationMs / 1000).toFixed(1);
    const state = r.skipped ? "SKIP (cloud sent)" : r.ok ? "OK" : `FAILED: ${r.message}`;
    console.log(`  [${r.symbol}] ${r.phase} ${state} (${dt}s)`);
  }
  console.log(`Done — sent ${summary.sent}, skipped ${summary.skipped}, failed ${summary.failed}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 6: Delete dead code**

Remove `runEmailSweep` and `EmailSweepResult` from `lib/calendar/enrichment-runner.ts` (lines ~550-607). Keep `findEmailCandidates`, `EmailCandidate`, `EmailSweepOpts` (the sweep + tests use them).

- [ ] **Step 7: Run tests + build**

Run: `npx vitest run tests/calendar/ && npx next build 2>&1 | tail -5`
Expected: tests PASS; build compiles (catches any lingering import of the deleted symbols).

- [ ] **Step 8: Commit**

```bash
git add lib/calendar/email-sweep.ts app/api/cron/earnings-sweep/route.ts scripts/sweep-earnings-emails.ts lib/calendar/enrichment-runner.ts tests/calendar/email-sweep.test.ts
git commit -m "fix(earnings): sweep now runs the Mac↔cloud marker dance — kills awake-Mac double-sends (B1)"
```

---

### Task 8: Cross-process claim rows kill concurrent-sweep duplicates (B3)

The shell's 240s curl timeout + three-tier fallback re-runs the sweep while the first is mid-compose; audit rows are written only post-send, so in-flight candidates send twice. Fix: claim the `(event_id, phase)` slot in `earnings_emails` (UNIQUE constraint) BEFORE composing, with `error='in_progress'`; release on failure; stale claims (>30 min) reaped at sweep start. Also bump the shell timeout.

**Files:**
- Modify: `lib/digest/send-earnings-email.ts` (`sendEarningsEmail` + new claim helpers), `lib/calendar/email-sweep.ts` (stale-claim reap at top), `lib/queries/earnings-emails.ts` (`getSentPhasesForEvents` excludes in-progress claims), `scripts/enrich-calendar-events.sh:76` (max-time 240→600)
- Test: `tests/digest/earnings-email-claims.test.ts` (new)

**Interfaces:**
- Consumes: `runEarningsEmailSweep` from Task 7.
- Produces:

```typescript
// exported from lib/digest/send-earnings-email.ts for tests + the sweep reap:
export function claimEarningsEmailSlot(
  db: Database.Database,
  eventId: number,
  phase: "preview" | "recap",
  recipient: string,
): { claimed: boolean; mode: "fresh" | "refire"; reason?: "in_progress" };
export function releaseEarningsEmailClaim(
  db: Database.Database,
  eventId: number,
  phase: "preview" | "recap",
): void;
export function reapStaleEarningsEmailClaims(db: Database.Database): number;
```

Claim-state encoding (documented in code): `earnings_emails.error` is `'in_progress'` while a send is composing, `'sent-by-cloud'` for Worker-delivered emails (Task 7), `NULL` for completed local sends. Failed sends still end with NO row (claim released) so the next tick retries.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
// schema bootstrap as in other calendar/digest tests
import {
  claimEarningsEmailSlot,
  releaseEarningsEmailClaim,
  reapStaleEarningsEmailClaims,
} from "../../lib/digest/send-earnings-email";

describe("earnings email claim slot", () => {
  // beforeEach: db bootstrap + insert one calendar_events row → eventId

  it("first claim wins, concurrent second claim is refused", () => {
    const a = claimEarningsEmailSlot(db, eventId, "preview", "x@y.com");
    expect(a).toEqual({ claimed: true, mode: "fresh" });
    const b = claimEarningsEmailSlot(db, eventId, "preview", "x@y.com");
    expect(b.claimed).toBe(false);
    expect(b.reason).toBe("in_progress");
  });

  it("release deletes the claim so a retry can re-claim", () => {
    claimEarningsEmailSlot(db, eventId, "preview", "x@y.com");
    releaseEarningsEmailClaim(db, eventId, "preview");
    const again = claimEarningsEmailSlot(db, eventId, "preview", "x@y.com");
    expect(again.claimed).toBe(true);
  });

  it("stale in_progress claims (>30 min) can be taken over", () => {
    claimEarningsEmailSlot(db, eventId, "preview", "x@y.com");
    db.prepare(
      `UPDATE earnings_emails SET sent_at = datetime('now', '-45 minutes')
        WHERE event_id = ? AND phase = 'preview'`,
    ).run(eventId);
    const b = claimEarningsEmailSlot(db, eventId, "preview", "x@y.com");
    expect(b.claimed).toBe(true);
  });

  it("a completed row allows a manual re-fire (mode refire, no claim mutation)", () => {
    db.prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, ai_output_md, error)
       VALUES (?, 'preview', 'x@y.com', '# sent', NULL)`,
    ).run(eventId);
    const b = claimEarningsEmailSlot(db, eventId, "preview", "x@y.com");
    expect(b).toEqual({ claimed: true, mode: "refire" });
  });

  it("reapStaleEarningsEmailClaims deletes only stale in_progress rows", () => {
    claimEarningsEmailSlot(db, eventId, "preview", "x@y.com");
    db.prepare(
      `UPDATE earnings_emails SET sent_at = datetime('now', '-45 minutes')
        WHERE event_id = ?`,
    ).run(eventId);
    expect(reapStaleEarningsEmailClaims(db)).toBe(1);
    expect(
      db.prepare("SELECT COUNT(*) c FROM earnings_emails").get(),
    ).toEqual({ c: 0 });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/digest/earnings-email-claims.test.ts`
Expected: FAIL — exports don't exist.

- [ ] **Step 3: Implement the claim helpers** (in `lib/digest/send-earnings-email.ts`, near `recordEarningsEmailAudit`)

```typescript
// ── Cross-process send claims ──────────────────────────────────────
//
// The launchd shell has a curl timeout + tsx fallback chain; on a heavy tick
// the fallback re-runs the sweep while the first invocation is still
// composing (60-180s per Claude call), and audit rows land only post-send —
// so in-flight candidates used to send twice (audit 2026-07-04, bug B3).
// The UNIQUE(event_id, phase) constraint doubles as a cross-process mutex:
// claim the slot with error='in_progress' BEFORE composing. States:
//   error='in_progress'   → claim held by a live send (or a crashed one; reaped after 30 min)
//   error='sent-by-cloud' → Worker fallback delivered (email-sweep.ts writes these)
//   error IS NULL         → completed local send
// A failed send releases its fresh claim so the next tick retries.

const CLAIM_STALE_MINUTES = 30;

export function claimEarningsEmailSlot(
  db: Database.Database,
  eventId: number,
  phase: "preview" | "recap",
  recipient: string,
): { claimed: boolean; mode: "fresh" | "refire"; reason?: "in_progress" } {
  const ins = db
    .prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, ai_input_hash, ai_output_md, error)
       VALUES (?, ?, ?, datetime('now'), NULL, NULL, 'in_progress')
       ON CONFLICT(event_id, phase) DO NOTHING`,
    )
    .run(eventId, phase, recipient);
  if (ins.changes === 1) return { claimed: true, mode: "fresh" };

  const existing = db
    .prepare(
      `SELECT error FROM earnings_emails WHERE event_id = ? AND phase = ?`,
    )
    .get(eventId, phase) as { error: string | null } | undefined;

  if (existing?.error === "in_progress") {
    // Take over only if the holder looks dead (claim older than the stale cutoff).
    const takeover = db
      .prepare(
        `UPDATE earnings_emails
            SET sent_at = datetime('now'), recipient = ?
          WHERE event_id = ? AND phase = ? AND error = 'in_progress'
            AND datetime(sent_at) <= datetime('now', '-${CLAIM_STALE_MINUTES} minutes')`,
      )
      .run(recipient, eventId, phase);
    if (takeover.changes === 1) return { claimed: true, mode: "fresh" };
    return { claimed: false, mode: "fresh", reason: "in_progress" };
  }

  // Completed row (local send or cloud-sent placeholder): this is a manual
  // re-fire — allowed; the final audit upsert overwrites in place.
  return { claimed: true, mode: "refire" };
}

export function releaseEarningsEmailClaim(
  db: Database.Database,
  eventId: number,
  phase: "preview" | "recap",
): void {
  db.prepare(
    `DELETE FROM earnings_emails
      WHERE event_id = ? AND phase = ? AND error = 'in_progress'`,
  ).run(eventId, phase);
}

export function reapStaleEarningsEmailClaims(db: Database.Database): number {
  return db
    .prepare(
      `DELETE FROM earnings_emails
        WHERE error = 'in_progress'
          AND datetime(sent_at) <= datetime('now', '-${CLAIM_STALE_MINUTES} minutes')`,
    )
    .run().changes;
}
```

- [ ] **Step 4: Wire the claim into `sendEarningsEmail`**

Replace the body between the recipient check and the audit write:

```typescript
  const claim = claimEarningsEmailSlot(db, eventId, phase, recipient);
  if (!claim.claimed) {
    throw new EarningsEmailError(
      `Event ${eventId} ${phase} is already being sent by another process — skipping duplicate.`,
      409,
    );
  }

  let composed: ComposeEarningsResult;
  try {
    composed = await composeEarningsEmail(db, eventId, phase, {
      footerNote: opts.footerNote,
    });

    const phaseEmoji = phase === "preview" ? "\u{1F50D}" : "\u{1F4CA}";
    try {
      await sendEmail({
        to: recipient,
        subject: `${phaseEmoji} ${composed.title}`,
        html: composed.html,
        fromLocalPart: "earnings",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new EarningsEmailError(`Send failed: ${msg}`, 500);
    }
  } catch (err) {
    // A fresh claim must not survive a failed compose/send — the next sweep
    // tick should retry. (Refire mode never wrote a claim row.)
    if (claim.mode === "fresh") releaseEarningsEmailClaim(db, eventId, phase);
    throw err;
  }
```

(The existing `recordEarningsEmailAudit` call then upserts the real values with `error: null`, converting the claim into the completed row.)

- [ ] **Step 5: Reap stale claims at sweep start**

In `lib/calendar/email-sweep.ts`, at the top of `runEarningsEmailSweep` (before `findEmailCandidates`):

```typescript
import { reapStaleEarningsEmailClaims } from "@/lib/digest/send-earnings-email";
// ...
  const reaped = reapStaleEarningsEmailClaims(db);
  if (reaped > 0) {
    console.warn(`[earnings-sweep] reaped ${reaped} stale in-progress claim(s) from a dead process`);
  }
```

(Reap must run BEFORE candidate selection — a stale claim row otherwise hides its event from `findEmailCandidates` forever.)

- [ ] **Step 6: Honest UI chips — exclude live claims from `getSentPhasesForEvents`**

In `lib/queries/earnings-emails.ts`, change the WHERE clause:

```typescript
      `SELECT event_id, phase FROM earnings_emails
        WHERE event_id IN (${eventIds.map(() => "?").join(",")})
          AND (error IS NULL OR error != 'in_progress')`,
```

('sent-by-cloud' rows count as sent — correct; in-flight claims do not.)

- [ ] **Step 7: Shell timeout bump**

In `scripts/enrich-calendar-events.sh` line 76, change `try_http_post 240` → `try_http_post 600` and update the sweep-section comment:

```bash
# ── 2. Earnings email sweep (Phase 3) ───────────────────────────────
# Self-gates on the candidate window — empty windows return immediately
# with `swept: 0`. 600s budget: multi-candidate ticks run 60-180s of Claude
# compose per email. DB claim rows (error='in_progress') make the tsx
# fallback idempotent even if this HTTP call times out mid-loop.
```

- [ ] **Step 8: Run tests + full suite**

Run: `npx vitest run tests/digest/ tests/calendar/ tests/queries/`
Expected: all PASS (the Task 7 sweep tests still pass — their mock of `send-earnings-email` must now also export the three claim helpers; update that mock accordingly).

- [ ] **Step 9: Commit**

```bash
git add lib/digest/send-earnings-email.ts lib/calendar/email-sweep.ts lib/queries/earnings-emails.ts scripts/enrich-calendar-events.sh tests/digest/earnings-email-claims.test.ts tests/calendar/email-sweep.test.ts
git commit -m "fix(earnings): claim-row mutex kills concurrent-sweep duplicate sends + 600s sweep budget (B3)"
```

---

### Task 9: Blocked-recap Pushover alert

Last season 10 previewed names got no recap because actuals never arrived — silently. Alert once per event when a previewed earnings event sits 2h+ post-release with no actual, deep-linking to the Today page (manual actuals entry lives in BogeysEditModal there).

**Files:**
- Modify: `lib/calendar/email-sweep.ts` (add `alertBlockedRecaps`, call from `runEarningsEmailSweep`)
- Test: `tests/calendar/email-sweep.test.ts` (add cases)

**Interfaces:**
- Consumes: `calendar_events.actual_missing_alerted_at` (Task 6 migration), `sendPushover` from `lib/alerts/notify-pushover.ts` (exists; graceful no-op without env vars), `composeReleaseInstant` from `lib/calendar/reaction-snapshot.ts`.
- Produces: `export function alertBlockedRecaps(db, opts?: { now?: Date }): Promise<number>`; `SweepSummary` gains `recapAlerts: number`.

- [ ] **Step 1: Write the failing tests** (append to `tests/calendar/email-sweep.test.ts`)

```typescript
const pushover = vi.fn(async () => ({ sent: true }));
vi.mock("@/lib/alerts/notify-pushover", () => ({
  sendPushover: (...a: unknown[]) => pushover(...a),
}));

describe("alertBlockedRecaps", () => {
  it("pushes once for a previewed event >2h post-release with no actual, then never again", async () => {
    // fixture: earnings event released 3h before `now`, preview audit row
    // (error NULL), actual_value NULL, no recap row/skip
    const n1 = await alertBlockedRecaps(db, { now });
    expect(n1).toBe(1);
    expect(pushover).toHaveBeenCalledTimes(1);
    const n2 = await alertBlockedRecaps(db, { now });
    expect(n2).toBe(0); // actual_missing_alerted_at dedup
  });

  it("does not alert when the actual landed", async () => {
    // same fixture but actual_value set
    expect(await alertBlockedRecaps(db, { now })).toBe(0);
  });

  it("does not alert without a sent preview", async () => {
    // same fixture but no earnings_emails preview row
    expect(await alertBlockedRecaps(db, { now })).toBe(0);
  });

  it("does not alert before 2h or after 18h post-release", async () => {
    // release 1h ago → 0 ; release 20h ago → 0
  });
});
```

Build fixtures with explicit `release_time` and `event_date` derived from the injected `now` (remember: `release_time` is ET wall-clock — use `composeReleaseInstant` in the test to derive a consistent pair, mirroring how the existing enrichment-runner tests construct windows).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/calendar/email-sweep.test.ts`
Expected: new cases FAIL (`alertBlockedRecaps` not exported).

- [ ] **Step 3: Implement** (in `lib/calendar/email-sweep.ts`)

```typescript
import { composeReleaseInstant } from "./reaction-snapshot";
import { sendPushover } from "@/lib/alerts/notify-pushover";

// A previewed print with no actual after this long is "blocked" — the recap
// gate (actual_value IS NOT NULL) will never open on its own. 2h floor gives
// Finnhub + the retry loop (Task 6) a fair chance first.
const BLOCKED_RECAP_MIN_AGE_MS = 2 * 60 * 60 * 1000;
// Ceiling keeps next-morning catch-up ticks useful for AMC prints (launchd
// gate closes before AMC+2h) without alerting about ancient events.
const BLOCKED_RECAP_MAX_AGE_MS = 18 * 60 * 60 * 1000;

interface BlockedRecapRow {
  id: number;
  symbol: string;
  event_date: string;
  release_time: string;
}

/**
 * Pushover once per event when a PREVIEWED earnings print has been out >2h
 * with no actual captured — last season 10 previews died silently this way
 * (audit 2026-07-04 §2). The push deep-links to the Today page where the
 * BogeysEditModal actuals override lives; entering an actual re-opens the
 * recap path (the sweep picks it up next tick).
 */
export async function alertBlockedRecaps(
  db: Database.Database,
  opts: { now?: Date } = {},
): Promise<number> {
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();

  const rows = db
    .prepare(
      `SELECT ce.id, ce.symbol, ce.event_date, ce.release_time
         FROM calendar_events ce
         JOIN earnings_emails ep
           ON ep.event_id = ce.id AND ep.phase = 'preview'
          AND (ep.error IS NULL OR ep.error NOT IN ('in_progress'))
         LEFT JOIN earnings_emails er
           ON er.event_id = ce.id AND er.phase = 'recap'
         LEFT JOIN earnings_email_skips es
           ON es.event_id = ce.id AND es.phase = 'recap'
        WHERE ce.event_type = 'earnings'
          AND COALESCE(ce.superseded, 0) = 0
          AND ce.actual_value IS NULL
          AND ce.actual_missing_alerted_at IS NULL
          AND ce.release_time IS NOT NULL
          AND ce.symbol IS NOT NULL
          AND ce.event_date >= date('now', '-2 days')
          AND er.id IS NULL
          AND es.id IS NULL`,
    )
    .all() as BlockedRecapRow[];

  let alerted = 0;
  for (const row of rows) {
    const release = composeReleaseInstant(row.event_date, row.release_time);
    if (!release) continue;
    const ageMs = nowMs - release.getTime();
    if (ageMs < BLOCKED_RECAP_MIN_AGE_MS || ageMs > BLOCKED_RECAP_MAX_AGE_MS) continue;

    // Stamp BEFORE pushing — one alert per event even if Pushover errors.
    db.prepare(
      `UPDATE calendar_events SET actual_missing_alerted_at = datetime('now') WHERE id = ?`,
    ).run(row.id);

    const hours = Math.round(ageMs / (60 * 60 * 1000));
    await sendPushover({
      title: `${row.symbol} recap blocked — no actuals`,
      message:
        `${row.symbol} reported ~${hours}h ago but no actual EPS/Rev has arrived, ` +
        `so the recap email is blocked. Enter actuals manually to unblock it.`,
      url: `${process.env.PUSHOVER_LINK_BASE ?? "http://localhost:3099"}/dashboard/today`,
      urlTitle: "Open Earnings Hub",
    });
    alerted += 1;
  }
  return alerted;
}
```

Wire into `runEarningsEmailSweep` just before the return, and add `recapAlerts` to `SweepSummary`:

```typescript
  const recapAlerts = await alertBlockedRecaps(db, { now: opts.now });
  return {
    swept: candidates.length,
    sent: results.filter((r) => r.ok && !r.skipped).length,
    skipped: results.filter((r) => r.skipped).length,
    failed: results.filter((r) => !r.ok).length,
    recapAlerts,
    results,
  };
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/calendar/email-sweep.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/calendar/email-sweep.ts tests/calendar/email-sweep.test.ts
git commit -m "feat(earnings): Pushover alert when a previewed print has no actuals 2h post-release"
```

---

### Task 10: Full verification pass

**Files:** none new.

- [ ] **Step 1: Full test suite**

Run: `npx vitest run`
Expected: all pass (1600+ tests). Report exact counts. Do NOT proceed with failures.

- [ ] **Step 2: Build check**

Run: `npx next build 2>&1 | tail -8`
Expected: compiles clean.

- [ ] **Step 3: Live smoke of the sweep path**

Run: `npx tsx scripts/sweep-earnings-emails.ts`
Expected: `no email candidates` (July events are >1 day out) — proves the shared sweep + claim reap + alert query run against the real DB without error (this also exercises migration 062 columns).

- [ ] **Step 4: Verify July coverage held**

Run: `sqlite3 data/vanguard.db "SELECT COUNT(*) FROM calendar_events WHERE event_type='earnings' AND event_date BETWEEN '2026-07-05' AND '2026-07-19'"`
Expected: > 0 (Task 1's sync results still present).

- [ ] **Step 5: Report**

Summarize for the user: tests count, what shipped per bug ID, the July symbols now covered, and the follow-ups explicitly NOT done in this batch (cloud recap parity B8, shorts B7, watchlist sync B10, EarningsHub UI items — all in the audit doc's week-2 list).
