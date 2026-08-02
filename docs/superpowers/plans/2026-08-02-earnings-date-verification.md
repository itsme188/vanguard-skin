# Earnings Date/Slot Verification Tier — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify the date + BMO/AMC slot of every upcoming held/watchlist/read-through earnings event against the public record (Claude + web_search) once per day, auto-correcting wrong sync-sourced rows via the existing suppress+manual mechanism.

**Architecture:** Mirrors the sector-verification pattern (migration 071 / `lib/securities/verify-sector-tags.ts`): candidates → one batched Claude+web_search call → strict JSON verdicts → apply with guards → stamp `date_verified_at`. Corrections NEVER edit sync rows in place — the sync upsert's `release_time = COALESCE(excluded.release_time, …)` and `event_date = excluded.event_date` clauses would clobber any in-place fix on the next sync, so every correction goes through `deleteAndSuppressCalendarEvent` + `insertCalendarEvent` (manual rows are sync-immune), with bogey migration. That logic is extracted from `scripts/correct-earnings-date.ts` into a shared lib function.

**Why (live incidents, 2026-07-30 season):** RKT previewed on a Nasdaq-only phantom date (single-source rows never reach the Conflicts tab — it only compares Finnhub *vs* Nasdaq); LLY's active row for 8/05 carries the default 16:15 AMC slot while Nasdaq said 08:00 BMO (the superseded row had it right); IMAX previewed after its real print (both vendors mis-slotted).

**Tech Stack:** better-sqlite3, Claude via `getRawAnthropicClient` + `web_search_20250305` (native tool ⇒ raw client, model id from `resolveFeatureModel` — never hardcoded), Vitest with `runMigrations(db)` on `:memory:`.

## Global Constraints

- Every DB function takes `db: Database.Database` as first param (DI for `:memory:` tests).
- Dates `YYYY-MM-DD`; "today" is ALWAYS `todayET()` from `lib/calendar/date-utils` — never `new Date().toISOString()`.
- Claude JSON parsing gets BOTH defenses: `extractJsonArray` (`lib/ai/extract-json.ts`) + C0 control-char retry (`json.replace(/[\u0000-\u001f]+/g, " ")`).
- New feature key `earningsDateVerification` → `"anthropic/$workhorse"` in `FEATURE_MODELS`; model id derived via `resolveFeatureModel(key).modelId` at call time.
- Corrections require verdict `confidence === "confirmed"`. NEVER move a date on an unconfirmed verdict. NEVER touch a row whose `actual_value` is non-null (a captured print really happened).
- Commit messages: write to a temp file, `git commit -F <file>` (never inline `-m` — macOS bash 3.2 + quoting).
- Run `npx vitest run <file>` after each task; full suite (`npx vitest run`) at the end.
- Do not add `.slice()` on model output, do not hardcode Claude model ids, comparisons on `security_type`/symbols case-insensitive.

## File Structure

- `lib/db/migrations/072_earnings_date_verification.sql` — new columns.
- `lib/mutations/calendar.ts` — add `correctEarningsEventDate()` (extracted from the CLI); edit `upsertCalendarEvents` conflict clause to clear `date_verified_at` when the date moves.
- `scripts/correct-earnings-date.ts` — becomes a thin wrapper over the lib function.
- `lib/calendar/verify-earnings-dates.ts` — NEW: candidates + prompt + parse + apply + orchestrator (all pure/DI except the default Claude fetcher).
- `lib/ai/feature-keys.ts` + `lib/ai/models.ts` — register the feature key.
- `app/api/cron/earnings-sweep/route.ts` — once-per-ET-day hook after the sweep.
- `scripts/verify-earnings-dates.ts` — manual CLI (dry-run default, `--apply`).
- `tests/calendar/verify-earnings-dates.test.ts`, `tests/mutations/correct-earnings-event.test.ts` — new; `tests/calendar/sync-preserves-enrichment.test.ts` — extend.

---

### Task 1: Migration 072 + upsert clears stale verification stamps

**Files:**
- Create: `lib/db/migrations/072_earnings_date_verification.sql`
- Modify: `lib/mutations/calendar.ts` (upsertCalendarEvents conflict clause, ~line 95)
- Test: `tests/calendar/sync-preserves-enrichment.test.ts` (append one test)

**Interfaces:**
- Produces: `calendar_events.date_verified_at TEXT NULL`, `calendar_events.date_verification_note TEXT NULL`. Invariant: a sync upsert that CHANGES `event_date` NULLs `date_verified_at` + `date_verification_note` (the stamp certified the old date).

- [ ] **Step 1: Write the migration**

```sql
-- 072_earnings_date_verification.sql
-- Date/slot verification stamps for earnings calendar rows.
-- date_verified_at: set when a Claude+web_search pass confirmed (or a
-- correction re-established) this row's event_date + BMO/AMC slot.
-- date_verification_note: human-readable outcome ("confirmed via ir.example.com",
-- "unconfirmed — no company announcement found").
ALTER TABLE calendar_events ADD COLUMN date_verified_at TEXT;
ALTER TABLE calendar_events ADD COLUMN date_verification_note TEXT;
```

- [ ] **Step 2: Write the failing test** (append to `tests/calendar/sync-preserves-enrichment.test.ts`, reusing its existing `runMigrations(db)` setup pattern)

```ts
it("a sync upsert that moves event_date clears the date-verification stamp", () => {
  // Insert a finnhub row, stamp it verified, then re-upsert with a new date.
  upsertCalendarEvents(db, [baseEvent({ source_key: "finnhub:LLY:x", event_date: "2026-08-05" })]);
  db.prepare(
    `UPDATE calendar_events SET date_verified_at = datetime('now'),
       date_verification_note = 'confirmed' WHERE source_key = 'finnhub:LLY:x'`,
  ).run();
  upsertCalendarEvents(db, [baseEvent({ source_key: "finnhub:LLY:x", event_date: "2026-08-06" })]);
  const row = db.prepare(
    `SELECT date_verified_at, date_verification_note FROM calendar_events WHERE source_key = 'finnhub:LLY:x'`,
  ).get() as { date_verified_at: string | null; date_verification_note: string | null };
  expect(row.date_verified_at).toBeNull();
  expect(row.date_verification_note).toBeNull();

  // Same-date re-upsert keeps the stamp.
  db.prepare(`UPDATE calendar_events SET date_verified_at = datetime('now') WHERE source_key='finnhub:LLY:x'`).run();
  upsertCalendarEvents(db, [baseEvent({ source_key: "finnhub:LLY:x", event_date: "2026-08-06" })]);
  const row2 = db.prepare(`SELECT date_verified_at FROM calendar_events WHERE source_key='finnhub:LLY:x'`).get() as { date_verified_at: string | null };
  expect(row2.date_verified_at).not.toBeNull();
});
```

(Adapt `baseEvent` to whatever fixture helper that test file already uses — read the file first and reuse its existing event-builder.)

- [ ] **Step 3: Run test, verify it fails** — `npx vitest run tests/calendar/sync-preserves-enrichment.test.ts` (fails: stamp survives the date move).

- [ ] **Step 4: Edit the conflict clause** in `upsertCalendarEvents` — add two lines after `event_date = excluded.event_date,`:

```sql
date_verified_at = CASE WHEN excluded.event_date != calendar_events.event_date
                        THEN NULL ELSE calendar_events.date_verified_at END,
date_verification_note = CASE WHEN excluded.event_date != calendar_events.event_date
                        THEN NULL ELSE calendar_events.date_verification_note END,
```

- [ ] **Step 5: Run test, verify pass**, then run the whole calendar test dir: `npx vitest run tests/calendar`.

- [ ] **Step 6: Commit** (`git commit -F`) — `feat(calendar): migration 072 date-verification stamps, cleared when sync moves a date`

---

### Task 2: Extract `correctEarningsEventDate` into lib/mutations/calendar.ts

**Files:**
- Modify: `lib/mutations/calendar.ts` (new export), `scripts/correct-earnings-date.ts` (becomes wrapper)
- Test: `tests/mutations/correct-earnings-event.test.ts` (new)

**Interfaces:**
- Consumes: existing `deleteAndSuppressCalendarEvent(db, id)`, `insertCalendarEvent(db, input)`, `getSecurityIdForSymbol(db, symbol)`, `mondayOf(date)`.
- Produces:

```ts
export interface CorrectEarningsDateResult {
  ok: boolean;
  newEventId?: number;      // the corrected manual row (created or pre-existing)
  deletedIds?: number[];    // wrong rows removed + suppressed
  bogeysMigrated?: number;
  refusedReason?: string;   // set when ok=false (e.g. captured actuals)
}
export function correctEarningsEventDate(
  db: Database.Database,
  opts: { symbol: string; wrongDate: string; correctDate: string; slot?: "BMO" | "AMC" },
): CorrectEarningsDateResult;
```

- [ ] **Step 1: Write failing tests** — port the CLI's behavior into unit tests on `:memory:` + `runMigrations(db)`:

```ts
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { correctEarningsEventDate, upsertCalendarEvents, insertCalendarEvent } from "@/lib/mutations/calendar";

// helper: seed a finnhub earnings row
function seedFinnhub(db: Database.Database, symbol: string, date: string) {
  upsertCalendarEvents(db, [{
    source: "finnhub", event_type: "earnings", event_date: date, event_time: null,
    title: `${symbol} earnings`, description: null, symbol, security_id: null,
    expected_impact: "high", consensus_estimate: "EPS 1.00", previous_value: null,
    raw_json: null, source_key: `finnhub:${symbol}:${date}`, week_of: "2026-08-03",
    release_time: "16:15",
  }]);
  return (db.prepare(`SELECT id FROM calendar_events WHERE source_key = ?`)
    .get(`finnhub:${symbol}:${date}`) as { id: number }).id;
}

it("moves a wrong date: manual row created, wrong row deleted + suppressed, bogeys migrated", () => {
  const wrongId = seedFinnhub(db, "RKT", "2026-07-30");
  db.prepare(`INSERT INTO earnings_bogeys (event_id, source, source_label, eps_consensus) VALUES (?, 'manual', 'me', 0.5)`).run(wrongId);
  const res = correctEarningsEventDate(db, { symbol: "RKT", wrongDate: "2026-07-30", correctDate: "2026-08-06", slot: "AMC" });
  expect(res.ok).toBe(true);
  expect(res.deletedIds).toEqual([wrongId]);
  expect(res.bogeysMigrated).toBe(1);
  const manual = db.prepare(`SELECT id, event_date, event_time FROM calendar_events WHERE source='manual' AND symbol='RKT'`).get() as any;
  expect(manual.event_date).toBe("2026-08-06");
  // suppression recorded → re-sync of the wrong tuple is a no-op
  upsertCalendarEvents(db, []); // no-op sanity
  seedFinnhubExpectSuppressed(db, "RKT", "2026-07-30"); // upsert again, assert 0 rows on 07-30
});

it("refuses when the wrong row has captured actuals", () => {
  const id = seedFinnhub(db, "HUN", "2026-07-30");
  db.prepare(`UPDATE calendar_events SET actual_value='EPS 1.00' WHERE id=?`).run(id);
  const res = correctEarningsEventDate(db, { symbol: "HUN", wrongDate: "2026-07-30", correctDate: "2026-08-06" });
  expect(res.ok).toBe(false);
  expect(res.refusedReason).toMatch(/actuals/i);
  expect(db.prepare(`SELECT COUNT(*) c FROM calendar_events WHERE symbol='HUN'`).get()).toMatchObject({ c: 1 });
});

it("is idempotent: second call with no wrong rows still returns the manual row id", () => {
  seedFinnhub(db, "NET", "2026-07-30");
  const first = correctEarningsEventDate(db, { symbol: "NET", wrongDate: "2026-07-30", correctDate: "2026-08-06" });
  const second = correctEarningsEventDate(db, { symbol: "NET", wrongDate: "2026-07-30", correctDate: "2026-08-06" });
  expect(second.ok).toBe(true);
  expect(second.newEventId).toBe(first.newEventId);
  expect(second.deletedIds).toEqual([]);
});
```

- [ ] **Step 2: Run, verify fail** (function not exported).

- [ ] **Step 3: Implement** — lift the body of `scripts/correct-earnings-date.ts` (steps 1–3: insert-manual-first, `UPDATE OR IGNORE earnings_bogeys`, `deleteAndSuppressCalendarEvent` per wrong row) into the lib function verbatim, replacing `console.*`/`process.exit` with the result object. Keep the actuals-refusal FIRST (before any write). Slot default: `opts.slot ?? wrongRows[0]?.event_time ?? "AMC"`.

- [ ] **Step 4: Rewrite `scripts/correct-earnings-date.ts`** as arg-parse + one call + console report of the result (keep its usage banner and exit codes: refused → exit 1).

- [ ] **Step 5: Run tests, verify pass**; also `npx tsx scripts/correct-earnings-date.ts` with no args still prints usage.

- [ ] **Step 6: Commit** — `refactor(calendar): extract correctEarningsEventDate into lib, CLI wraps it`

---

### Task 3: verify-earnings-dates lib — candidates, prompt, parse (pure parts)

**Files:**
- Create: `lib/calendar/verify-earnings-dates.ts`
- Test: `tests/calendar/verify-earnings-dates.test.ts`

**Interfaces:**
- Consumes: `getSymbolStatus(db, symbols)` (`lib/queries/briefing-symbols`), `getReadThroughReporterSymbols(db)`, `issuerSiblings(symbol)`, `todayET(now)` / `addDays`, `extractJsonArray`.
- Produces:

```ts
export interface DateVerificationCandidate {
  id: number; symbol: string; event_date: string;
  event_time: string | null; release_time: string | null; source: string;
}
export interface DateVerdict {
  symbol: string;
  confirmed_date: string | null;   // YYYY-MM-DD
  slot: "bmo" | "amc" | null;
  confidence: "confirmed" | "unconfirmed";
  source: string | null;
}
export function findDateVerificationCandidates(
  db: Database.Database,
  opts?: { now?: Date; horizonDays?: number; limit?: number },
): DateVerificationCandidate[];
export function buildDateVerificationPrompt(candidates: DateVerificationCandidate[], todayStr: string): string;
export function parseDateVerdicts(text: string): DateVerdict[];
export function effectiveSlot(c: { event_time: string | null; release_time: string | null }): "bmo" | "amc" | null;
```

- [ ] **Step 1: Write failing tests**

```ts
// Candidates: seed holdings so one symbol is held (copy the minimal
// holdings/securities/accounts INSERT pattern from tests/calendar/event-suppressions.test.ts
// or tests/queries fixtures — getSymbolStatus reads latest holdings rows).
it("selects held + watchlist + read-through-reporter earnings inside the horizon", ...);
it("skips rows with actuals, superseded rows, already-verified rows, out-of-horizon rows", ...);
it("family-dedupes (GOOG/GOOGL) keeping the earliest-id row", ...);
it("caps at limit ordered by event_date asc", ...);

// effectiveSlot
it("derives bmo from event_time BMO, amc from AMC, falls back to release_time < 12:00 → bmo, null when neither", ...);

// parseDateVerdicts — both convention defenses
it("parses a clean JSON array", ...);
it("survives a prose preamble before the array (extractJsonArray)", ...);
it("survives raw control chars inside strings (C0 collapse retry)", ...);
it("drops malformed entries (bad date shape, unknown slot) instead of throwing", ...);
```

Candidate SQL (final JS filter for held/watchlist/reporter — SQL can't see holdings status cheaply):

```ts
const today = todayET(opts?.now);
const horizon = addDays(today, opts?.horizonDays ?? 7);
const rows = db.prepare(
  `SELECT id, symbol, event_date, event_time, release_time, source
     FROM calendar_events
    WHERE event_type = 'earnings'
      AND COALESCE(superseded, 0) = 0
      AND symbol IS NOT NULL
      AND actual_value IS NULL
      AND date_verified_at IS NULL
      AND event_date BETWEEN ? AND ?
    ORDER BY event_date ASC, id ASC`,
).all(today, horizon) as DateVerificationCandidate[];
const reporterSet = new Set(getReadThroughReporterSymbols(db).map((s) => s.toUpperCase()));
const status = getSymbolStatus(db, rows.map((r) => r.symbol));
const covered = rows.filter((r) => {
  const u = r.symbol.toUpperCase();
  return status[u] === "held" || status[u] === "watchlist" || reporterSet.has(u);
});
// family dedupe: key = sorted issuerSiblings, keep first (earliest date/id)
```

Prompt (exact text):

```ts
export function buildDateVerificationPrompt(candidates: DateVerificationCandidate[], todayStr: string): string {
  const lines = candidates.map((c) => {
    const slot = effectiveSlot(c) ?? "unknown slot";
    return `- ${c.symbol} — vendor says ${c.event_date}, ${slot}`;
  });
  return `You are verifying upcoming earnings report dates. Today is ${todayStr}.

For EACH company below, find the CONFIRMED date and timing of its next quarterly earnings report. Prefer the company's own investor-relations announcement or press release ("X to report results on ..."). A wire story or two agreeing independent calendars also count as confirmation. bmo = before the market opens, amc = after the market closes.

The vendor date/slot shown may be WRONG — that is why you are verifying. Do not assume it is right.

Candidates:
${lines.join("\n")}

Respond ONLY with a JSON array, one object per candidate symbol, no prose:
[{"symbol":"XYZ","confirmed_date":"YYYY-MM-DD","slot":"bmo","confidence":"confirmed","source":"<url or short citation>"}]

Rules: "confidence":"confirmed" ONLY with an explicit company announcement or two agreeing independent sources. If you cannot confirm, use "confidence":"unconfirmed" and set "confirmed_date" to your best finding or null. NEVER invent a date.`;
}
```

`parseDateVerdicts`: `extractJsonArray(text)` → `JSON.parse` → on SyntaxError retry with `.replace(/[\u0000-\u001f]+/g, " ")` → filter entries: `symbol` string, `confirmed_date` null or `/^\d{4}-\d{2}-\d{2}$/`, `slot` null|"bmo"|"amc" (lowercase it), `confidence` coerced to "unconfirmed" unless exactly "confirmed".

- [ ] **Step 2: Run, verify fail.** **Step 3: Implement.** **Step 4: Run, verify pass.**

- [ ] **Step 5: Commit** — `feat(calendar): date-verification candidates + prompt + verdict parsing`

---

### Task 4: apply logic + orchestrator + feature key

**Files:**
- Modify: `lib/calendar/verify-earnings-dates.ts`, `lib/ai/feature-keys.ts`, `lib/ai/models.ts`
- Test: `tests/calendar/verify-earnings-dates.test.ts` (extend)

**Interfaces:**
- Consumes: `correctEarningsEventDate` (Task 2), `getRawAnthropicClient` + `resolveFeatureModel` (copy the fetcher shape from `lib/securities/verify-sector-tags.ts` — same provider guard, `web_search_20250305` tool with `max_uses: 8`), `sendPushover` (`lib/alerts/notify-pushover`, graceful no-op without env).
- Produces:

```ts
export type VerificationAction = "verified" | "date-corrected" | "slot-corrected" | "unverifiable" | "refused";
export interface VerificationOutcome { candidate: DateVerificationCandidate; action: VerificationAction; detail: string; }
export function applyVerdict(
  db: Database.Database,
  candidate: DateVerificationCandidate,
  verdict: DateVerdict | undefined,
  opts: { apply: boolean },
): VerificationOutcome;
export async function runEarningsDateVerification(
  db: Database.Database,
  opts?: { now?: Date; apply?: boolean; limit?: number;
           fetchVerdicts?: (prompt: string) => Promise<string> },  // DI for tests
): Promise<{ outcomes: VerificationOutcome[]; corrections: number }>;
```

- [ ] **Step 1: Write failing tests for `applyVerdict`** (pure DB, no AI):

```ts
it("stamps date_verified_at + note on a confirmed match (date AND slot agree)", ...);
it("date-match slot-mismatch (confirmed) → correctEarningsEventDate same date new slot; new manual row stamped verified", ...);
it("date mismatch (confirmed) → correction to the new date; manual row stamped; suppression present", ...);
it("unconfirmed verdict → stamps verified_at with 'unconfirmed' note, NEVER corrects (row untouched)", ...);
it("missing verdict for a candidate → 'unverifiable', stamps with note so it is not retried daily", ...);
it("correction refused (actuals landed between candidate selection and apply) → action 'refused', no stamp changes on original", ...);
it("apply:false (dry-run) → outcomes computed, zero DB writes", ...);
```

Apply semantics (implement exactly):
- No verdict OR `confirmed_date === null`: stamp `date_verified_at = datetime('now')`, note `` `unverifiable — ${verdict?.source ?? "no source found"}` ``; action `unverifiable`.
- `confidence !== "confirmed"`: stamp with note `` `unconfirmed — left as vendor date (${verdict.confirmed_date ?? "?"} ${verdict.slot ?? "?"} suggested)` ``; action `unverifiable`. (Stamping prevents daily re-spend; the sync clearing stamps on date-change re-opens it if the vendor moves.)
- Confirmed + date equal + (slot equal OR verdict.slot null OR candidate slot null): stamp, note `` `confirmed via ${verdict.source ?? "web"}` ``; action `verified`.
- Confirmed + date equal + slot differs: `correctEarningsEventDate({symbol, wrongDate: event_date, correctDate: event_date, slot: verdict.slot.toUpperCase()})`; on ok stamp the NEW row (`date_verified_at`, note `` `slot corrected ${oldSlot}→${verdict.slot} via ${source}` ``); action `slot-corrected`. On refusal: action `refused`, note nothing.
- Confirmed + date differs: same call with `correctDate: verdict.confirmed_date`; stamp new row; action `date-corrected`; refusal → `refused`.

`runEarningsDateVerification`: candidates (limit default 8) → empty ⇒ return; prompt → `fetchVerdicts` (default: raw-client fetcher copied from verify-sector-tags: assert provider `anthropic`, `client.messages.create({ model: modelId, max_tokens: 4000, tools:[{type:"web_search_20250305", name:"web_search", max_uses:8}], messages:[{role:"user",content:prompt}] })`, concatenate ALL text blocks, taking care to join `content.filter(b => b.type==="text")`) → parse → `applyVerdict` per candidate (match verdicts by upper-cased symbol, also match via `issuerSiblings`) → if `corrections > 0 && opts.apply !== false`, fire ONE `sendPushover` summary: title `Earnings dates corrected (${corrections})`, message = one line per correction outcome detail. Wrap the whole body in try/catch that logs and returns partial outcomes — verification must NEVER throw into its caller.

- [ ] **Step 2–4: Fail → implement → pass.**

- [ ] **Step 5: Register the feature key** — in `lib/ai/feature-keys.ts` add `"earningsDateVerification"` to the `FeatureKey` union (alphabetical placement with the other earnings keys); in `lib/ai/models.ts` `FEATURE_MODELS` add `earningsDateVerification: "anthropic/$workhorse",`. Run `npx vitest run tests/ai` (tier tests enumerate keys).

- [ ] **Step 6: Commit** — `feat(calendar): apply verdicts + verification orchestrator, feature key earningsDateVerification`

---

### Task 5: daily wiring + manual CLI

**Files:**
- Modify: `app/api/cron/earnings-sweep/route.ts`, `lib/calendar/verify-earnings-dates.ts` (gate helper)
- Create: `scripts/verify-earnings-dates.ts`
- Test: `tests/calendar/verify-earnings-dates.test.ts` (extend)

**Interfaces:**
- Produces: `export async function maybeRunDailyDateVerification(db, opts?: { now?: Date; runner?: typeof runEarningsDateVerification }): Promise<{ ran: boolean }>` — settings-keyed once-per-ET-day gate.

- [ ] **Step 1: Write failing tests for the gate**

```ts
it("runs once per ET day after 05:00 ET and stamps settings key earnings_date_verify_last_run", ...);
it("second call same day is a no-op", ...);
it("before 05:00 ET does not run (BMO previews start ~06:25 — verification must precede them, so the gate opens at 05:00)", ...);
```

Gate implementation: read ET hour via `new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(now)`; settings get/set with `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value` (match the existing settings-table idiom in `lib/queries/earnings-settings.ts`). Stamp BEFORE running (one attempt per day even on failure — same stamp-before-push discipline as coverage guard). Table-existence-tolerant like other settings readers.

- [ ] **Step 2–3: Fail → implement → pass.**

- [ ] **Step 4: Wire into the sweep route** — in `app/api/cron/earnings-sweep/route.ts`, after `runEarningsEmailSweep(db)` returns, add fire-and-forget (`await`, but inside its own try/catch — a verification failure must not fail the sweep response):

```ts
try {
  await maybeRunDailyDateVerification(db);
} catch (err) {
  console.warn("[earnings-sweep] date verification pass failed:", err);
}
```

- [ ] **Step 5: CLI** — `scripts/verify-earnings-dates.ts`: dotenv `.env.local`, dry-run default printing each outcome (`SYMBOL date slot → action: detail`), `--apply` writes, `--limit N` optional. Uses `runEarningsDateVerification(db, { apply, limit })` directly (no daily gate).

- [ ] **Step 6: Live smoke (manual, expected in this repo):** `npx tsx scripts/verify-earnings-dates.ts` (dry-run) against the real DB — the current week (LLY, DIS, MELI, U…) is the perfect live fixture. Report the verdict table in the task summary; do NOT `--apply` (the main-session human reviews first).

- [ ] **Step 7: Full suite** `npx vitest run` → all green.

- [ ] **Step 8: Commit** — `feat(calendar): daily date-verification hook in earnings sweep + CLI`

---

### Task 6: docs

**Files:**
- Modify: `CLAUDE.md` (one bullet in the Conventions section, near the "Earnings email sweep" bullet), `docs/conventions-detail.md` (provenance: RKT/LLY/PRLB incidents, 2026-08-02).

- [ ] **Step 1:** CLAUDE.md bullet (keep it tight):

```
- **Earnings date/slot verification (migration 072, 2026-08-02)**: `lib/calendar/verify-earnings-dates.ts` verifies upcoming held/watchlist/read-through earnings dates+slots via Claude web_search once per ET day (gate opens 05:00, hooked after the earnings sweep; settings key `earnings_date_verify_last_run`; CLI `scripts/verify-earnings-dates.ts`, dry-run default). Confirmed mismatches auto-correct through `correctEarningsEventDate` (lib extraction of correct-earnings-date.ts — suppress+manual, bogeys migrated, refuses on captured actuals); corrections Pushover once per run. Stamps `date_verified_at`/`date_verification_note`; the sync upsert CLEARS both when a source moves `event_date`. Never edit a sync row's date/slot in place — the conflict clause re-clobbers it. Single-source (Nasdaq-only) dates are exactly the rows the Conflicts tab cannot catch (RKT 7/30) — this tier is their only net.
```

- [ ] **Step 2: Commit** — `docs: earnings date-verification conventions`

## Self-Review Notes

- Spec coverage: RKT single-source ✓ (verification is source-agnostic), LLY slot default ✓ (slot compare + correction), IMAX-class ✓ (same), re-verification after vendor moves a date ✓ (upsert clears stamps), cost bound ✓ (≤8 symbols/day, one Sonnet call), never-block-sweep ✓, never-touch-actuals ✓.
- Type consistency: `DateVerificationCandidate`/`DateVerdict`/`VerificationOutcome` used identically across Tasks 3–5; `correctEarningsEventDate` signature identical in Tasks 2 and 4.
- Deliberately out of scope (noted for future): Data Health panel for verification state; Worker-side mirror (Mac-only is fine — verification is not time-critical to the minute); persisting learned slots into `SYMBOL_RELEASE_TIMES_ET` (manual rows carry correct times already).
