# Earnings Wave 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Coverage guard (auto-fix + residual alert), push-at-print (Mac + Worker), shorts in earnings emails (B7), and watchlist/option-only coverage (B10) — the Wave 1 batch from `docs/superpowers/specs/2026-07-05-earnings-wave1-design.md`.

**Architecture:** Four additive components on the existing earnings pipeline. New pure modules: `lib/calendar/coverage-guard.ts` (gap detection + block renderer) and `lib/alerts/print-push-message.ts` (pure message composer, byte-parity mirrored to the Worker) + `lib/alerts/print-push.ts` (marker-deduped sender). Everything else is targeted edits to existing files. No migrations.

**Tech Stack:** TypeScript 5, better-sqlite3 (DI), Vitest `:memory:` DBs, Cloudflare Worker (workers/cron).

**Spec:** `docs/superpowers/specs/2026-07-05-earnings-wave1-design.md` — read it once before starting any task.

## Global Constraints

- Every DB function takes `db: Database.Database`; dates `YYYY-MM-DD`; "today" via `todayET()` (`lib/calendar/date-utils.ts`), never UTC `toISOString().slice`.
- Case-insensitive `security_type` comparisons (`LOWER(COALESCE(s.security_type,'')) IN ('stock','common stock')` for stock-like; a PostToolUse hook rejects case-sensitive comparisons).
- Issuer-family: never symbol-string-equal on user-visible surfaces — expand via `issuerSiblings` (`lib/securities/issuer-family.ts`; the Worker has its own mirror — grep `workers/cron/src` for `issuerSiblings` and use it).
- No raw Finnhub-shape strings (`"EPS X · Rev N"`) reach the user.
- Pushes/marker calls are best-effort: `sendPushover` never throws; marker helpers no-op gracefully without `WORKER_MARKER_URL`; no push failure may block enrichment, reconcile, or the briefing.
- Worker mirrors are byte-parity below the header comment, pinned by a parity test (pattern: `workers/cron/test/editions.test.ts`).
- Tests mock AI/email/push modules — never depend on `.env.local`.
- Run the focused test while iterating; full `npx vitest run` before each commit; `tsc` must stay clean.
- Coverage-guard gap constants: `DUE_AFTER_DAYS = 75`, `LOOKAHEAD_DAYS = 45`. Print-push marker TTL: 24h, key `print-push-{eventId}`.
- Push content is public market data only — no position info, no dollar exposure.

---

### Task 1: Coverage-guard module

**Files:**
- Create: `lib/calendar/coverage-guard.ts`
- Test: `tests/calendar/coverage-guard.test.ts`

**Interfaces:**
- Consumes: `issuerSiblings`, `todayET`/`addDays` (`lib/calendar/date-utils.ts`), `settings` table (key-value, may be absent in minimal DBs — guard with try/catch like `lib/queries/risk-free-rate.ts`).
- Produces (Task 2 relies on these exact signatures):

```typescript
export interface CoverageGap {
  symbol: string;
  kind: "due_no_event" | "no_history";
  lastEventDate: string | null;
  daysSinceLast: number | null;
}
export function findEarningsCoverageGaps(
  db: Database.Database,
  opts?: { today?: string },   // YYYY-MM-DD; defaults to todayET()
): CoverageGap[];
export function renderCoverageGapsBlock(gaps: CoverageGap[]): string; // "" when empty
export function getCoverageGuardIgnoredSymbols(db: Database.Database): string[];
```

- [ ] **Step 1: Write the failing tests**

Bootstrap an in-memory DB with the migration runner (copy the exact setup from `tests/calendar/delete-preserves-children.test.ts`). Helpers: insert an account, a stock security + latest holding (`quantity` param so a short works), a watchlist row, and earnings events with controllable `event_date`/`superseded`. Cases (fix `today = "2026-07-05"` and derive all dates from it):

```typescript
describe("findEarningsCoverageGaps", () => {
  it("flags a held stock whose last report is >75d old with nothing scheduled in 45d", () => {
    // held AAPL, last earnings event 2026-04-10 (86d before today), no future event
    const gaps = findEarningsCoverageGaps(db, { today: "2026-07-05" });
    expect(gaps).toEqual([
      { symbol: "AAPL", kind: "due_no_event", lastEventDate: "2026-04-10", daysSinceLast: 86 },
    ]);
  });

  it("stays quiet for a name that just reported (last event 30d ago)", () => { /* → [] */ });

  it("stays quiet when a FUTURE event exists within 45d (superseded=0)", () => { /* → [] */ });

  it("a superseded future event does NOT count as coverage", () => {
    // future event with superseded=1 only → still a gap
  });

  it("a sibling's event covers the family (held GOOG, future GOOGL event)", () => { /* → [] */ });

  it("no-history names get kind no_history", () => {
    // held stock, zero earnings events ever
    // → [{ symbol, kind: "no_history", lastEventDate: null, daysSinceLast: null }]
  });

  it("watchlist stocks are candidates too", () => { /* watchlist-only name with stale history → gap */ });

  it("short positions (quantity < 0) are candidates", () => { /* held -300 sh → gap when due */ });

  it("ETFs and options are never candidates", () => { /* security_type 'ETF' held → [] */ });

  it("ignored symbols are excluded", () => {
    db.prepare(`INSERT INTO settings (key, value) VALUES ('coverage_guard_ignored_symbols', '["402340"]')`).run();
    // held 402340 with no history → []
  });
});

describe("renderCoverageGapsBlock", () => {
  it("returns empty string for no gaps", () => expect(renderCoverageGapsBlock([])).toBe(""));
  it("renders due and no-history lines under a ## heading", () => {
    const out = renderCoverageGapsBlock([
      { symbol: "JPM", kind: "due_no_event", lastEventDate: "2026-04-11", daysSinceLast: 85 },
      { symbol: "XYZ", kind: "no_history", lastEventDate: null, daysSinceLast: null },
    ]);
    expect(out).toContain("## Earnings coverage gaps");
    expect(out).toContain("**JPM** — last report 2026-04-11 (85d ago); nothing scheduled in the next 45 days");
    expect(out).toContain("**XYZ** — no earnings history in the calendar; verify coverage");
  });
});
```

(Adjust `settings` insert to the real schema — check migration for the settings table; it's key/value TEXT.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/calendar/coverage-guard.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `lib/calendar/coverage-guard.ts`**

```typescript
/**
 * Earnings coverage guard — the residual-alert half of the Wave 1 design
 * (docs/superpowers/specs/2026-07-05-earnings-wave1-design.md §1).
 *
 * The auto-fix half is the briefing pipeline's 4-week sync reach; this module
 * answers "which held/watchlist names have a report DUE with no source
 * covering it" — the failure mode that produced the July 2026 bank-week hole.
 * Pure DB reads; runs Sunday inside sendBriefingEmail (best-effort).
 */

import type Database from "better-sqlite3";
import { issuerSiblings } from "@/lib/securities/issuer-family";
import { todayET, addDays } from "@/lib/calendar/date-utils";

// A report is "due" when the last one is older than this. 75d + the 45d
// look-ahead brackets the quarterly cycle: a name that reported 60d ago has
// its next print ~30d out and typically already scheduled.
const DUE_AFTER_DAYS = 75;
const LOOKAHEAD_DAYS = 45;
const IGNORED_KEY = "coverage_guard_ignored_symbols";

export interface CoverageGap {
  symbol: string;
  kind: "due_no_event" | "no_history";
  lastEventDate: string | null;
  daysSinceLast: number | null;
}

/** Hand-editable escape valve for known-uncoverable names (e.g. foreign
 *  listings Finnhub never returns). JSON array in the settings table; no UI. */
export function getCoverageGuardIgnoredSymbols(db: Database.Database): string[] {
  try {
    const row = db
      .prepare(`SELECT value FROM settings WHERE key = ?`)
      .get(IGNORED_KEY) as { value: string } | undefined;
    if (!row?.value?.trim()) return [];
    const parsed = JSON.parse(row.value) as unknown;
    return Array.isArray(parsed) ? parsed.map((s) => String(s).toUpperCase()) : [];
  } catch {
    return []; // settings table absent (minimal test DBs) or malformed JSON
  }
}

export function findEarningsCoverageGaps(
  db: Database.Database,
  opts: { today?: string } = {},
): CoverageGap[] {
  const today = opts.today ?? todayET();
  const horizon = addDays(today, LOOKAHEAD_DAYS);
  const dueCutoff = addDays(today, -DUE_AFTER_DAYS);
  const ignored = new Set(getCoverageGuardIgnoredSymbols(db));

  // Held stock-like names, quantity != 0 (a short into a print matters),
  // latest row per (account, security) — same shape as getSymbolStatus's
  // held check, widened to shorts.
  const heldRows = db
    .prepare(
      `SELECT DISTINCT UPPER(s.symbol) AS symbol
         FROM holdings h
         JOIN securities s ON s.id = h.security_id
        WHERE h.quantity != 0
          AND LOWER(COALESCE(s.security_type, '')) IN ('stock', 'common stock')
          AND s.symbol IS NOT NULL AND s.symbol != ''
          AND h.as_of_date = (
            SELECT MAX(h2.as_of_date) FROM holdings h2
             WHERE h2.account_id = h.account_id AND h2.security_id = h.security_id
          )`,
    )
    .all() as { symbol: string }[];

  const watchlistRows = db
    .prepare(
      `SELECT DISTINCT UPPER(s.symbol) AS symbol
         FROM watchlist w
         JOIN securities s ON s.id = w.security_id
        WHERE w.is_active = 1
          AND LOWER(COALESCE(s.security_type, '')) IN ('stock', 'common stock')`,
    )
    .all() as { symbol: string }[];

  const candidates = Array.from(
    new Set([...heldRows, ...watchlistRows].map((r) => r.symbol)),
  )
    .filter((sym) => !ignored.has(sym))
    .sort();

  const gaps: CoverageGap[] = [];
  for (const symbol of candidates) {
    const family = issuerSiblings(symbol).map((s) => s.toUpperCase());
    const placeholders = family.map(() => "?").join(",");

    const future = db
      .prepare(
        `SELECT 1 FROM calendar_events
          WHERE event_type = 'earnings'
            AND COALESCE(superseded, 0) = 0
            AND event_date BETWEEN ? AND ?
            AND UPPER(symbol) IN (${placeholders})
          LIMIT 1`,
      )
      .get(today, horizon, ...family);
    if (future) continue;

    // Any past event (superseded included) is evidence a source covers the name.
    const last = db
      .prepare(
        `SELECT MAX(event_date) AS d FROM calendar_events
          WHERE event_type = 'earnings'
            AND event_date <= ?
            AND UPPER(symbol) IN (${placeholders})`,
      )
      .get(today, ...family) as { d: string | null };

    if (!last.d) {
      gaps.push({ symbol, kind: "no_history", lastEventDate: null, daysSinceLast: null });
      continue;
    }
    if (last.d < dueCutoff) {
      const daysSinceLast = Math.round(
        (Date.parse(today + "T00:00:00Z") - Date.parse(last.d + "T00:00:00Z")) / 86_400_000,
      );
      gaps.push({ symbol, kind: "due_no_event", lastEventDate: last.d, daysSinceLast });
    }
  }

  // due_no_event first (actionable), then no_history; alpha within each.
  return gaps.sort((a, b) =>
    a.kind === b.kind ? a.symbol.localeCompare(b.symbol) : a.kind === "due_no_event" ? -1 : 1,
  );
}

/** Deterministic markdown block appended to the Sunday briefing by code
 *  (never via the AI prompt). Empty string when there is nothing to say. */
export function renderCoverageGapsBlock(gaps: CoverageGap[]): string {
  if (gaps.length === 0) return "";
  const lines = gaps.map((g) =>
    g.kind === "due_no_event"
      ? `- **${g.symbol}** — last report ${g.lastEventDate} (${g.daysSinceLast}d ago); nothing scheduled in the next ${LOOKAHEAD_DAYS} days`
      : `- **${g.symbol}** — no earnings history in the calendar; verify coverage`,
  );
  return `## Earnings coverage gaps\n\n${lines.join("\n")}`;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/calendar/coverage-guard.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/calendar/coverage-guard.ts tests/calendar/coverage-guard.test.ts
git commit -m "feat(earnings): coverage-guard module — due-and-missing gap detection + briefing block renderer"
```

---

### Task 2: Wire guard into the Sunday briefing (4-week sync + block + Pushover)

**Files:**
- Modify: `lib/digest/send-briefing.ts` (sync loop at ~line 148; the `briefingToHtml` call at ~line 251)

**Interfaces:**
- Consumes: Task 1's `findEarningsCoverageGaps` / `renderCoverageGapsBlock`; `sendPushover` (`lib/alerts/notify-pushover.ts` — never throws); `addDays`.
- Produces: nothing new for later tasks.

- [ ] **Step 1: Extend the sync loop reach**

In `lib/digest/send-briefing.ts`, change:

```typescript
  for (const w of [weekOf, addDays(weekOf, 7)]) {
```
to:
```typescript
  // 4 weeks of reach: earnings dates confirm 2-4+ weeks out, and the July
  // 2026 bank week was structurally unreachable at [week, +1] (audit
  // 2026-07-04). Idempotent; ~+2 min of Finnhub pacing on Sundays.
  for (const w of [weekOf, addDays(weekOf, 7), addDays(weekOf, 14), addDays(weekOf, 21)]) {
```

- [ ] **Step 2: Run the guard after the sync loop**

Immediately after the sync `for` loop closes, add (imports at top of file):

```typescript
  // Coverage guard (Wave 1 §1): with 4 weeks of sync reach, a name that
  // STILL has no scheduled event when a report is due means no source has
  // it — surface it rather than fail silently. Best-effort: a guard failure
  // must never block the briefing.
  let coverageGapsBlock = "";
  try {
    const gaps = findEarningsCoverageGaps(db);
    coverageGapsBlock = renderCoverageGapsBlock(gaps);
    if (gaps.length > 0) {
      const symbols = gaps.map((g) => g.symbol).join(", ");
      void sendPushover({
        title: "Earnings coverage gaps",
        message: `${gaps.length} name(s) with a report due and nothing scheduled: ${symbols}`,
        url: `${process.env.PUSHOVER_LINK_BASE ?? "http://localhost:3099"}/dashboard/today`,
        urlTitle: "Open Earnings Hub",
      });
    }
  } catch (err) {
    console.warn(`[coverage-guard] skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
```

- [ ] **Step 3: Append the block at send time (not into the cached briefing row)**

At the `briefingToHtml` call (~line 251):

```typescript
  // Coverage block is appended at SEND time so it's always fresh — the
  // cached calendar_briefings.content row stays pure AI output.
  const contentForEmail = coverageGapsBlock
    ? `${briefing.content}\n\n---\n\n${coverageGapsBlock}`
    : briefing.content;
  const html = briefingToHtml(contentForEmail, title, opts.footerNote);
```

(If a variable between the guard code and this call is out of scope, hoist `coverageGapsBlock` declaration accordingly — both live in `sendBriefingEmail`.)

- [ ] **Step 4: Run the briefing test suite + tsc**

Run: `npx vitest run tests/calendar/ tests/digest/ && npx tsc --noEmit 2>&1 | tail -3`
Expected: all PASS; tsc clean. (Existing briefing tests must not break; if one pins the sync-loop week list, update it to the 4-week list and say so in your report.)

- [ ] **Step 5: Commit**

```bash
git add lib/digest/send-briefing.ts
git commit -m "feat(earnings): Sunday briefing syncs 4 weeks ahead + coverage-gap block + Pushover alert"
```

---

### Task 3: B10 — option-only held status + watchlist/underlyings in the sync scan

**Files:**
- Modify: `lib/queries/briefing-symbols.ts` (`getSymbolStatus` at lines 64-125; add `getHeldOptionUnderlyingSymbols`), `lib/queries/watchlist.ts` (add `getActiveWatchlistStockSymbols`), `lib/calendar/sync.ts:178-190` (scan-set merge)
- Test: extend the existing test file covering `getSymbolStatus` (grep `tests/` for it; likely `tests/queries/briefing-symbols.test.ts`), extend `tests/calendar/sync.test.ts`

**Interfaces:**
- Produces (Tasks 4/5 depend on the `getSymbolStatus` behavior change; Task 6's snapshot uses the watchlist query):

```typescript
// briefing-symbols.ts
export function getHeldOptionUnderlyingSymbols(db: Database.Database): string[];
// watchlist.ts
export function getActiveWatchlistStockSymbols(db: Database.Database): string[];
// getSymbolStatus: unchanged signature; a symbol is now "held" ALSO when any
// account's latest holdings contain an unexpired option (quantity != 0) whose
// underlying_symbol is the symbol or an issuer sibling.
```

- [ ] **Step 1: Write the failing tests**

`getSymbolStatus` (follow the existing file's fixtures):

```typescript
it("classifies a symbol held only via options as held", () => {
  // securities: TER option (security_type 'Option', underlying_symbol 'TER',
  // expiration_date 1 year out), NO TER stock holding
  // holdings: option quantity 2 at latest as_of_date
  expect(getSymbolStatus(db, ["TER"])).toEqual({ TER: "held" });
});

it("an EXPIRED option does not confer held status", () => {
  // same but expiration_date in the past → "neither" (or "watchlist" if watchlisted)
});

it("a short option position confers held status (quantity != 0)", () => { /* quantity -1 → held */ });

it("option underlying matches via issuer family", () => {
  // option on GOOGL, query GOOG → held
});
```

Sync scan-set (in `tests/calendar/sync.test.ts`, following its existing mock pattern for `fetchFinnhubEarningsForSymbols`):

```typescript
it("merges watchlist symbols and held-option underlyings into the Finnhub scan", async () => {
  // held stock AAPL; watchlist stock SHOP; held TER option (no TER stock)
  // run syncCalendarForWeek with Finnhub mocked
  // assert the symbols list passed to fetchFinnhubEarningsForSymbols
  //   contains AAPL, SHOP, TER (deduped, uppercase)
});
```

- [ ] **Step 2: Run to verify failures**

Run: `npx vitest run tests/queries/briefing-symbols.test.ts tests/calendar/sync.test.ts` (adjust the first path to the real file)
Expected: new cases FAIL.

- [ ] **Step 3: Implement**

`lib/queries/briefing-symbols.ts` — inside `getSymbolStatus`, after the `heldRows` query, add a second held source:

```typescript
  // Option-only exposure counts as held: a TER LEAP with no TER stock still
  // makes TER's print matter (same look-through the earnings composer does
  // via underlying_symbol). Unexpired, quantity != 0 (shorts carry exposure).
  const optionHeldRows = db
    .prepare(
      `SELECT DISTINCT UPPER(s.underlying_symbol) AS symbol
         FROM holdings h
         JOIN securities s ON s.id = h.security_id
        WHERE UPPER(COALESCE(s.underlying_symbol, '')) IN (${placeholders})
          AND LOWER(COALESCE(s.security_type, '')) = 'option'
          AND h.quantity != 0
          AND (s.expiration_date IS NULL OR s.expiration_date >= date('now'))
          AND h.as_of_date = (
            SELECT MAX(h2.as_of_date) FROM holdings h2
             WHERE h2.account_id = h.account_id AND h2.security_id = h.security_id
          )`,
    )
    .all(...distinctInput) as { symbol: string }[];
  for (const r of optionHeldRows) held.add(r.symbol);
```

New function in the same file:

```typescript
/**
 * Distinct underlyings of currently-held unexpired options (quantity != 0).
 * Fed into the Finnhub earnings scan so option-only names get their events
 * synced (Wave 1 B10 — a TER-LEAP-only book must still see TER's print).
 */
export function getHeldOptionUnderlyingSymbols(db: Database.Database): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT UPPER(s.underlying_symbol) AS symbol
         FROM holdings h
         JOIN securities s ON s.id = h.security_id
        WHERE LOWER(COALESCE(s.security_type, '')) = 'option'
          AND s.underlying_symbol IS NOT NULL AND s.underlying_symbol != ''
          AND h.quantity != 0
          AND (s.expiration_date IS NULL OR s.expiration_date >= date('now'))
          AND h.as_of_date = (
            SELECT MAX(h2.as_of_date) FROM holdings h2
             WHERE h2.account_id = h.account_id AND h2.security_id = h.security_id
          )
        ORDER BY symbol`,
    )
    .all() as { symbol: string }[];
  return rows.map((r) => r.symbol);
}
```

`lib/queries/watchlist.ts`:

```typescript
/** Active watchlist symbols, stock-like only, uppercase — the earnings-scan
 *  candidate shape (Wave 1 B10). */
export function getActiveWatchlistStockSymbols(db: Database.Database): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT UPPER(s.symbol) AS symbol
         FROM watchlist w
         JOIN securities s ON s.id = w.security_id
        WHERE w.is_active = 1
          AND LOWER(COALESCE(s.security_type, '')) IN ('stock', 'common stock')
          AND s.symbol IS NOT NULL AND s.symbol != ''
        ORDER BY symbol`,
    )
    .all() as { symbol: string }[];
  return rows.map((r) => r.symbol);
}
```

`lib/calendar/sync.ts` — replace the merge (~lines 178-186):

```typescript
      // Scan set = held stocks ∪ read-through reporters ∪ active watchlist
      // ∪ held-option underlyings. Watchlist names get full earnings parity
      // (user decision, Wave 1); option-only names (e.g. a TER LEAP with no
      // TER stock) must see their print too. Deduped + uppercase to keep the
      // Finnhub call count tight.
      const heldSymbols = getHeldStockSymbols(db);
      const reporterSymbols = getReadThroughReporterSymbols(db);
      const watchlistSymbols = getActiveWatchlistStockSymbols(db);
      const optionUnderlyings = getHeldOptionUnderlyingSymbols(db);
      const symbols = Array.from(
        new Set(
          [...heldSymbols, ...reporterSymbols, ...watchlistSymbols, ...optionUnderlyings].map(
            (s) => s.toUpperCase(),
          ),
        ),
      ).sort();
      const extras = symbols.length - heldSymbols.length;
      const extrasSuffix =
        extras > 0 ? ` (+ ${extras} watchlist/reporter/underlying)` : "";
      send({
        phase: "finnhub_fetch",
        message: `Scanning ${symbols.length} symbol${symbols.length === 1 ? "" : "s"} via Finnhub${extrasSuffix}...`,
      });
```

(Keep the imports tidy: add the two new query imports at the top of sync.ts.)

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/queries/ tests/calendar/`
Expected: all PASS (the old "reporterSuffix" message wording change may break a sync test asserting the message string — update it and note it).

- [ ] **Step 5: Commit**

```bash
git add lib/queries/briefing-symbols.ts lib/queries/watchlist.ts lib/calendar/sync.ts tests/
git commit -m "feat(earnings): option-only exposure counts as held + watchlist/underlyings join the Finnhub scan (B10)"
```

---

### Task 4: Print-push message composer (pure, Worker-mirrored) + Mac sender + enrichment hook

**Files:**
- Create: `lib/alerts/print-push-message.ts` (pure — NO imports; Worker mirror in Task 6), `lib/alerts/print-push.ts`
- Modify: `lib/cron/earnings-marker-check.ts` (add print-push marker helpers), `lib/calendar/enrichment-runner.ts` (hook after the update in `runEnrichment`)
- Test: `tests/alerts/print-push-message.test.ts`, `tests/alerts/print-push.test.ts`, extend `tests/calendar/enrichment-runner.test.ts`

**Interfaces:**
- Consumes: `sendPushover` (never throws), `workerFetch` pattern inside `earnings-marker-check.ts`, `getSymbolStatus` + `getEarningsSettings`/`shouldSendEarningsEmail` (already imported by enrichment-runner).
- Produces:

```typescript
// print-push-message.ts (PURE - no imports; byte-parity Worker mirror)
export function composePrintPushMessage(input: {
  symbol: string;
  actualValue: string;          // Finnhub-shape "EPS 1.42 · Rev 775000000" or "EPS 1.42 · Rev 775,000,000"
  consensusValue: string | null;
  reactionJson: string | null;  // reaction_snapshot JSON or null
}): { title: string; message: string };

// print-push.ts
export async function sendEarningsPrintPush(input: {
  eventId: number;
  symbol: string;
  actualValue: string;
  consensusValue: string | null;
  reactionJson: string | null;
}): Promise<{ pushed: boolean; reason?: string }>;

// earnings-marker-check.ts additions
export async function checkPrintPushMarker(eventId: number): Promise<boolean>; // true = already pushed
export function writePrintPushMarker(eventId: number): Promise<Response | null>;
```

- [ ] **Step 1: Write the failing composer tests**

```typescript
import { describe, it, expect } from "vitest";
import { composePrintPushMessage } from "../../lib/alerts/print-push-message";

describe("composePrintPushMessage", () => {
  it("renders EPS + Rev actual vs consensus with compact revenue", () => {
    const out = composePrintPushMessage({
      symbol: "TER",
      actualValue: "EPS 1.42 · Rev 775,200,000",
      consensusValue: "EPS 1.35 · Rev 762,000,000",
      reactionJson: null,
    });
    expect(out.title).toBe("TER reported");
    expect(out.message).toBe("EPS 1.42 vs 1.35 est · Rev 775.2M vs 762.0M");
  });

  it("omits missing halves (EPS-only actual, no consensus)", () => {
    const out = composePrintPushMessage({
      symbol: "U", actualValue: "EPS 0.23", consensusValue: null, reactionJson: null,
    });
    expect(out.message).toBe("EPS 0.23");
  });

  it("appends the reaction when present", () => {
    const out = composePrintPushMessage({
      symbol: "TER",
      actualValue: "EPS 1.42 · Rev 775,200,000",
      consensusValue: "EPS 1.35 · Rev 762,000,000",
      reactionJson: JSON.stringify({
        source: "yahoo", window_min: 120,
        symbol: { symbol: "TER", delta_pct: 4.12 },
        spy: { delta_pct: 0.41 },
      }),
    });
    expect(out.message).toBe(
      "EPS 1.42 vs 1.35 est · Rev 775.2M vs 762.0M · TER +4.12% vs SPY +0.41% (T+2h)",
    );
  });

  it("billion-scale revenue renders as B", () => {
    const out = composePrintPushMessage({
      symbol: "AAPL", actualValue: "Rev 94,300,000,000", consensusValue: "Rev 93,100,000,000", reactionJson: null,
    });
    expect(out.message).toBe("Rev 94.3B vs 93.1B");
  });

  it("malformed reaction json is ignored gracefully", () => { /* message has no reaction tail */ });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/alerts/print-push-message.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `lib/alerts/print-push-message.ts`**

Self-contained by design (the Worker mirror can't import `lib/format/finnhub-figure.ts` across the path-alias boundary — same reason `presence-position.ts` is a hand-copy):

```typescript
/**
 * Push-at-print message composer (Wave 1 §2).
 *
 * PURE and dependency-free ON PURPOSE: workers/cron/src/print-push-message.ts
 * is a byte-parity mirror of everything below this header (parity-tested).
 * Do not add imports here — change both files together.
 *
 * Input actual/consensus are the Finnhub-shape strings stored in
 * calendar_events ("EPS 1.42 · Rev 775,200,000"); output is human-formatted
 * public market data only (no position info ever).
 */

interface ParsedFigure {
  eps: string | null;      // verbatim EPS token, e.g. "1.42" / "-0.24"
  revenueRaw: number | null;
}

function parseFigure(raw: string | null): ParsedFigure {
  if (!raw) return { eps: null, revenueRaw: null };
  const epsMatch = raw.match(/EPS\s+(-?[\d.]+)/i);
  const revMatch = raw.match(/Rev\s+([\d,]+(?:\.\d+)?)/i);
  const revenueRaw = revMatch ? Number(revMatch[1].replace(/,/g, "")) : null;
  return {
    eps: epsMatch ? epsMatch[1] : null,
    revenueRaw: Number.isFinite(revenueRaw ?? NaN) ? revenueRaw : null,
  };
}

function compactRevenue(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
}

function pct(v: number): string {
  const s = v.toFixed(2);
  return v >= 0 ? `+${s}%` : `${s}%`;
}

export function composePrintPushMessage(input: {
  symbol: string;
  actualValue: string;
  consensusValue: string | null;
  reactionJson: string | null;
}): { title: string; message: string } {
  const act = parseFigure(input.actualValue);
  const cons = parseFigure(input.consensusValue);

  const parts: string[] = [];
  if (act.eps != null) {
    parts.push(cons.eps != null ? `EPS ${act.eps} vs ${cons.eps} est` : `EPS ${act.eps}`);
  }
  if (act.revenueRaw != null) {
    parts.push(
      cons.revenueRaw != null
        ? `Rev ${compactRevenue(act.revenueRaw)} vs ${compactRevenue(cons.revenueRaw)}`
        : `Rev ${compactRevenue(act.revenueRaw)}`,
    );
  }

  if (input.reactionJson) {
    try {
      const snap = JSON.parse(input.reactionJson) as {
        symbol?: { delta_pct?: number };
        spy?: { delta_pct?: number };
      };
      const symPct = snap.symbol?.delta_pct;
      const spyPct = snap.spy?.delta_pct;
      if (typeof symPct === "number" && typeof spyPct === "number") {
        parts.push(`${input.symbol.toUpperCase()} ${pct(symPct)} vs SPY ${pct(spyPct)} (T+2h)`);
      }
    } catch {
      // malformed snapshot → no reaction tail
    }
  }

  return {
    title: `${input.symbol.toUpperCase()} reported`,
    message: parts.join(" · "),
  };
}
```

Run the composer tests → PASS. Adjust nothing else yet.

- [ ] **Step 4: Marker helpers in `lib/cron/earnings-marker-check.ts`**

Append (reusing the file's private `workerFetch`):

```typescript
/**
 * Push-at-print dedup marker (Wave 1 §2). Whichever side (Mac enrichment,
 * Mac reconcile, Worker cloud-enrich) captures the actual checks this BEFORE
 * pushing and writes it after. `false`/unreachable → allow the push (a
 * duplicate requires both sides active, which requires the Worker reachable).
 */
export async function checkPrintPushMarker(eventId: number): Promise<boolean> {
  const params = new URLSearchParams({ eventId: String(eventId) });
  const res = await workerFetch("/internal/print-push-marker", params, "GET");
  if (!res || !res.ok) return false;
  try {
    const body = (await res.json()) as { pushed?: boolean };
    return body.pushed === true;
  } catch {
    return false;
  }
}

export function writePrintPushMarker(eventId: number): Promise<Response | null> {
  const params = new URLSearchParams({ eventId: String(eventId) });
  return workerFetch("/internal/print-push-marker", params, "POST");
}
```

- [ ] **Step 5: Implement `lib/alerts/print-push.ts` + its tests**

```typescript
/**
 * Marker-deduped push-at-print sender — both Mac capture sites (enrichment
 * runner + cloud reconcile) call this. Best-effort everywhere: marker
 * check degrades to "not pushed" when the Worker is unreachable, and
 * sendPushover never throws.
 */

import { sendPushover } from "./notify-pushover";
import { composePrintPushMessage } from "./print-push-message";
import {
  checkPrintPushMarker,
  writePrintPushMarker,
} from "@/lib/cron/earnings-marker-check";

export async function sendEarningsPrintPush(input: {
  eventId: number;
  symbol: string;
  actualValue: string;
  consensusValue: string | null;
  reactionJson: string | null;
}): Promise<{ pushed: boolean; reason?: string }> {
  const alreadyPushed = await checkPrintPushMarker(input.eventId);
  if (alreadyPushed) return { pushed: false, reason: "already_pushed" };

  const { title, message } = composePrintPushMessage(input);
  const result = await sendPushover({
    title,
    message,
    url: `${process.env.PUSHOVER_LINK_BASE ?? "http://localhost:3099"}/dashboard/today`,
    urlTitle: "Open Earnings Hub",
  });
  if (result.sent) void writePrintPushMarker(input.eventId);
  return result.sent
    ? { pushed: true }
    : { pushed: false, reason: result.reason ?? "pushover_failed" };
}
```

Tests (`tests/alerts/print-push.test.ts`) — `vi.mock` both `./notify-pushover` and `@/lib/cron/earnings-marker-check`:
- marker says pushed → no sendPushover call, `{pushed:false, reason:"already_pushed"}`
- marker clear + push sent → sendPushover called once, writePrintPushMarker called
- pushover not configured (`{sent:false}`) → no marker write, `pushed:false`

- [ ] **Step 6: Enrichment hook + tests**

In `lib/calendar/enrichment-runner.ts`, `runEnrichment` loop, immediately AFTER the `update.run(...)` call (import `sendEarningsPrintPush` at top; `getSymbolStatus`/`getEarningsSettings`/`shouldSendEarningsEmail` are already imported for the sweep):

```typescript
      // Push-at-print (Wave 1 §2): fire exactly on the null→non-null actual
      // transition for a covered, unmuted earnings name. Best-effort — a
      // push failure never affects enrichment.
      if (
        isEarnings &&
        event.symbol &&
        event.actual_value == null &&
        actualResult.actual != null
      ) {
        try {
          const sym = event.symbol.toUpperCase();
          const status = getSymbolStatus(db, [sym])[sym];
          const settings = getEarningsSettings(db);
          if (
            (status === "held" || status === "watchlist") &&
            shouldSendEarningsEmail(settings, sym)
          ) {
            await sendEarningsPrintPush({
              eventId: event.id,
              symbol: sym,
              actualValue: actualResult.actual,
              consensusValue: actualResult.consensus ?? event.consensus_estimate,
              reactionJson: reaction
                ? JSON.stringify(reaction)
                : event.reaction_snapshot,
            });
          }
        } catch (err) {
          console.warn(`[print-push] event ${event.id} failed:`, err);
        }
      }
```

Tests in `tests/calendar/enrichment-runner.test.ts` (follow the file's existing mock/injection pattern; add `vi.mock` for `@/lib/alerts/print-push`):
- first actual capture on a held earnings row → `sendEarningsPrintPush` called once with the event's values
- retry tick where the actual was already stored (`event.actual_value` set) → NOT called
- muted symbol → NOT called; non-held/non-watchlist symbol → NOT called
- macro row with actual → NOT called

- [ ] **Step 7: Run + commit**

Run: `npx vitest run tests/alerts/ tests/calendar/enrichment-runner.test.ts && npx tsc --noEmit 2>&1 | tail -3`
Expected: all PASS, tsc clean.

```bash
git add lib/alerts/print-push-message.ts lib/alerts/print-push.ts lib/cron/earnings-marker-check.ts lib/calendar/enrichment-runner.ts tests/alerts/ tests/calendar/enrichment-runner.test.ts
git commit -m "feat(earnings): push-at-print — pure composer + marker-deduped sender + enrichment capture hook"
```

---

### Task 5: Print-push from the reconcile path

**Files:**
- Modify: `lib/calendar/cloud-reconcile.ts` (selectRow + push hook in the loop)
- Test: extend `tests/calendar/cloud-reconcile.test.ts`

**Interfaces:**
- Consumes: Task 4's `sendEarningsPrintPush` (marker check inside it handles "Worker already pushed"), `getSymbolStatus`, `getEarningsSettings`/`shouldSendEarningsEmail`.

- [ ] **Step 1: Write the failing tests** (extend the existing file; `vi.mock` `@/lib/alerts/print-push`):

- payload with actual landing on a row whose `actual_value` was NULL and `event_type='earnings'` with a held symbol → `sendEarningsPrintPush` called once (with `reactionJson` from the payload when present)
- payload actual on a row that ALREADY had an actual → not called
- deferred payload → not called
- macro row (`event_type != 'earnings'`) → not called
- muted symbol → not called

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/calendar/cloud-reconcile.test.ts`

- [ ] **Step 3: Implement**

1. Add `event_type, symbol` to `selectRow`'s SELECT and its row type.
2. After the write branch (the `reconciled += 1;` line), before `deleteFromWorker`:

```typescript
      // Push-at-print for cloud-captured actuals (Wave 1 §2). The marker
      // check inside sendEarningsPrintPush dedups against a push the Worker
      // already fired at capture time. Best-effort.
      if (
        payload.actual != null &&
        existing.actual_value == null &&
        existing.event_type === "earnings" &&
        existing.symbol
      ) {
        try {
          const sym = existing.symbol.toUpperCase();
          const status = getSymbolStatus(db, [sym])[sym];
          const settings = getEarningsSettings(db);
          if (
            (status === "held" || status === "watchlist") &&
            shouldSendEarningsEmail(settings, sym)
          ) {
            await sendEarningsPrintPush({
              eventId,
              symbol: sym,
              actualValue: payload.actual,
              consensusValue: payload.consensus ?? existing.consensus_value,
              reactionJson: payload.reaction
                ? JSON.stringify(payload.reaction)
                : existing.reaction_snapshot,
            });
          }
        } catch (err) {
          console.warn(`[print-push] reconcile event ${eventId} failed:`, err);
        }
      }
```

(Imports at top: `sendEarningsPrintPush`, `getSymbolStatus`, `getEarningsSettings`, `shouldSendEarningsEmail`.)

- [ ] **Step 4: Run + commit**

Run: `npx vitest run tests/calendar/cloud-reconcile.test.ts tests/calendar/`
Expected: all PASS.

```bash
git add lib/calendar/cloud-reconcile.ts tests/calendar/cloud-reconcile.test.ts
git commit -m "feat(earnings): push-at-print from the cloud-reconcile capture path"
```

---

### Task 6: Worker side — marker endpoints, cloud-enrich push, snapshot watchlist

**Files:**
- Create: `workers/cron/src/print-push-message.ts` (byte-parity mirror of `lib/alerts/print-push-message.ts` below the header)
- Modify: `workers/cron/src/earnings-markers.ts` (print-push key + read/write), `workers/cron/src/index.ts` (two `/internal/print-push-marker` routes), `workers/cron/src/calendar-enrich.ts` (push hook after payload KV put), `workers/cron/src/state.ts` (`watchlistSymbols?: string[]`, schemaVersion `| 8`), `scripts/snapshot-state-to-r2.ts` (write `watchlistSymbols`, `schemaVersion: 8`)
- Test: `workers/cron/test/print-push-message.test.ts` (parity + behavior), extend `workers/cron/test/calendar-enrich.test.ts`

**Interfaces:**
- Consumes: `sendPushover(env, opts)` from `workers/cron/src/pushover.ts`; the Worker's issuer-family mirror (grep `workers/cron/src` for `issuerSiblings` and import it); snapshot `heldSymbols` + `earningsSettings.mutedSymbols`.
- Produces:

```typescript
// earnings-markers.ts additions
export function printPushKey(eventId: number): string;              // `print-push-${eventId}`
export async function readPrintPushMarker(env, eventId: number): Promise<boolean>;
export async function writePrintPushMarker(env, eventId: number): Promise<void>; // 24h TTL
// state.ts
watchlistSymbols?: string[];   // additive; absent in snapshots ≤ v7 → held-only pushes
```

- [ ] **Step 1: Mirror + parity test**

Copy everything below the header comment of `lib/alerts/print-push-message.ts` into `workers/cron/src/print-push-message.ts` with a Worker-side header noting the mirror relationship. Parity test (follow `workers/cron/test/editions.test.ts`'s byte-parity approach — read both files, strip headers, assert equality) + re-run 2-3 of the Mac composer's behavior cases against the Worker copy.

Run: `npx vitest run workers/cron/test/print-push-message.test.ts` → PASS.

- [ ] **Step 2: Marker functions + routes**

`earnings-markers.ts`:

```typescript
const PRINT_PUSH_TTL_SECONDS = 24 * 3600;

export function printPushKey(eventId: number): string {
  return `print-push-${eventId}`;
}

export async function readPrintPushMarker(
  env: { CRON_KV: KVNamespace },
  eventId: number,
): Promise<boolean> {
  return (await env.CRON_KV.get(printPushKey(eventId))) != null;
}

export async function writePrintPushMarker(
  env: { CRON_KV: KVNamespace },
  eventId: number,
): Promise<void> {
  await env.CRON_KV.put(printPushKey(eventId), new Date().toISOString(), {
    expirationTtl: PRINT_PUSH_TTL_SECONDS,
  });
}
```

(Match the env typing the file already uses for its other functions — copy its exact idiom.)

`index.ts` — add next to the existing `/internal/earnings-marker` handlers (~line 645), copying their exact auth + param-parsing idiom:

```typescript
    if (request.method === "GET" && url.pathname === "/internal/print-push-marker") {
      // [same X-Cron-Secret auth guard as /internal/earnings-marker]
      const eventId = Number(url.searchParams.get("eventId"));
      if (!Number.isInteger(eventId)) return /* 400 per the file's idiom */;
      return Response.json({ pushed: await readPrintPushMarker(env, eventId) });
    }
    if (request.method === "POST" && url.pathname === "/internal/print-push-marker") {
      // [same auth guard]
      const eventId = Number(url.searchParams.get("eventId"));
      if (!Number.isInteger(eventId)) return /* 400 */;
      await writePrintPushMarker(env, eventId);
      return Response.json({ ok: true });
    }
```

- [ ] **Step 3: Cloud-enrich push hook**

In `workers/cron/src/calendar-enrich.ts`, after the `env.CRON_KV.put(cloudEnrichedKey(cand.id), ...)` (~line 304), add (read the surrounding function first for the snapshot variable name and result counters):

```typescript
      // Push-at-print (Wave 1 §2): the Worker is often the first to capture
      // an actual while the Mac sleeps — push immediately rather than waiting
      // for the Mac's wake-up reconcile. Held/watchlist from the snapshot
      // (watchlistSymbols is additive v8; older snapshots → held-only),
      // muted list respected, issuer-family aware, KV-marker deduped.
      if (
        cand.event_type === "earnings" &&
        cand.symbol &&
        payload.actual != null &&
        !payload.deferred
      ) {
        try {
          const sym = cand.symbol.toUpperCase();
          const family = issuerSiblings(sym).map((s) => s.toUpperCase());
          const heldSet = new Set((snapshot.heldSymbols ?? []).map((s) => s.toUpperCase()));
          const watchSet = new Set((snapshot.watchlistSymbols ?? []).map((s) => s.toUpperCase()));
          const muted = new Set(
            (snapshot.earningsSettings?.mutedSymbols ?? []).map((s) => s.toUpperCase()),
          );
          const enabled = snapshot.earningsSettings?.enabled !== false;
          const covered = family.some((f) => heldSet.has(f) || watchSet.has(f));
          const isMuted = family.some((f) => muted.has(f));
          if (enabled && covered && !isMuted && !(await readPrintPushMarker(env, cand.id))) {
            const { title, message } = composePrintPushMessage({
              symbol: sym,
              actualValue: payload.actual,
              consensusValue: payload.consensus,
              reactionJson: payload.reaction ? JSON.stringify(payload.reaction) : null,
            });
            const pushRes = await sendPushover(env, {
              title,
              message,
              url: `${env.PUSHOVER_LINK_BASE ?? "http://100.96.0.1:3099"}/dashboard/today`,
              urlTitle: "Open Earnings Hub",
            });
            if (pushRes.sent) await writePrintPushMarker(env, cand.id);
          }
        } catch (err) {
          console.warn(`[calendar-enrich] print-push failed for ${cand.id}:`, err);
        }
      }
```

Adapt to the file's actual shapes: `sendPushover`'s Worker signature (`workers/cron/src/pushover.ts:28`), whether `env.PUSHOVER_LINK_BASE` exists as a Worker binding (grep `wrangler.toml` + `env` typing; if absent, use the level-scan push's existing link pattern instead — match whatever `level-scan.ts` does), the candidate's `event_type`/`symbol` field names (~line 234), and the snapshot variable in scope. Say in your report exactly what you adapted.

- [ ] **Step 4: Snapshot `watchlistSymbols`**

`scripts/snapshot-state-to-r2.ts`: find the snapshot assembly (~line 452, `schemaVersion: 7`). Bump to `8` and add `watchlistSymbols` sourced the same way the script's other read-only queries work (it has local RO query functions like `getHeldStockSymbolsRO` — add a sibling):

```typescript
function getActiveWatchlistStockSymbolsRO(db: Database.Database): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT UPPER(s.symbol) AS symbol
         FROM watchlist w
         JOIN securities s ON s.id = w.security_id
        WHERE w.is_active = 1
          AND LOWER(COALESCE(s.security_type, '')) IN ('stock', 'common stock')
          AND s.symbol IS NOT NULL AND s.symbol != ''
        ORDER BY symbol`,
    )
    .all() as { symbol: string }[];
  return rows.map((r) => r.symbol);
}
```

`workers/cron/src/state.ts`: `schemaVersion: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;` and `watchlistSymbols?: string[];` with a comment that absence (≤v7) degrades Worker pushes to held-only.

- [ ] **Step 5: Worker tests**

Extend `workers/cron/test/calendar-enrich.test.ts` (follow its DI/stub pattern):
- earnings candidate + actual captured + symbol in `heldSymbols` → pushover stub called once + marker written
- marker already present → no push
- symbol only in `watchlistSymbols` → pushed; symbol in neither → not pushed
- muted symbol → not pushed; `deferred` payload → not pushed
- snapshot without `watchlistSymbols` (v7) → held-only behavior, no crash

Run: `npx vitest run workers/cron/test/` → all PASS.

- [ ] **Step 6: Commit**

```bash
git add workers/cron/src/ workers/cron/test/ scripts/snapshot-state-to-r2.ts
git commit -m "feat(earnings): Worker-side push-at-print + print-push marker endpoints + snapshot v8 watchlistSymbols"
```

---

### Task 7: B7 — shorts in earnings emails (Mac + Worker)

**Files:**
- Modify: `lib/digest/send-earnings-email.ts:596` (`getCrossAccountPositions` quantity filter), `scripts/snapshot-state-to-r2.ts:389-391` (holdings query), `workers/cron/src/fallback-earnings.ts` (drop the `quantity <= 0` skip ~line 388 region; replace the signed-sum netting ~lines 497-501), `workers/cron/src/presence-position.ts` (port `formatCombinedExposurePresence`)
- Test: extend `tests/digest/earnings-prompt-no-dollar-leak.test.ts`, extend the presence-position parity test (grep `workers/cron/test/` for it), extend `workers/cron/test/fallback-earnings.test.ts`

**Interfaces:**
- Consumes: `formatCombinedExposurePresence` (`lib/digest/presence-only-position.ts:116-132` — port verbatim below the mirror header).
- Produces: no signature changes anywhere.

- [ ] **Step 1: Write the failing tests**

Mac (`tests/digest/earnings-prompt-no-dollar-leak.test.ts`, following its fixture pattern):

```typescript
it("a short stock position surfaces in the preview context (not 'does not hold')", () => {
  // holdings row quantity -300 for the event's symbol
  // build the preview context/prompt; expect it to contain "300 short shares"
  // (via formatCombinedExposurePresence) and NOT claim no position
});
```

Worker (`workers/cron/test/fallback-earnings.test.ts`):

```typescript
it("renders long and short buckets separately, never a netted count", () => {
  // snapshot holdings: +500 shares and -300 shares of the family
  // rendered positions/summary must contain "500 long shares" AND "300 short shares"
  // and must NOT contain "200"
});
it("a short-only position renders presence, not 'No current holdings'", () => { /* ... */ });
```

- [ ] **Step 2: Run to verify failures**

Run: `npx vitest run tests/digest/earnings-prompt-no-dollar-leak.test.ts workers/cron/test/fallback-earnings.test.ts`
Expected: new cases FAIL.

- [ ] **Step 3: Implement**

1. `lib/digest/send-earnings-email.ts:596`: `AND h.quantity > 0` → `AND h.quantity != 0` (the long/short split in `buildPreviewContext` and `formatCombinedExposurePresence` already handle both signs — verify by reading `buildPreviewContext`'s accumulation at ~lines 374-383 and say so in your report).
2. `scripts/snapshot-state-to-r2.ts` holdings query (~line 391): `WHERE h.quantity > 0` → `WHERE h.quantity != 0`. ONLY this query — lines ~168/220 are different fields (verify each is NOT the fallback-earnings holdings feed before leaving them; report what each feeds).
3. `workers/cron/src/presence-position.ts`: append `formatCombinedExposurePresence` — verbatim copy of `lib/digest/presence-only-position.ts:116-132`, inside the byte-parity mirrored region.
4. `workers/cron/src/fallback-earnings.ts`: remove the `quantity <= 0 → continue` skip; replace the signed-sum-then-abs summary (~497-501) with accumulation into `{longShares, shortShares, longContracts, shortContracts}` buckets (option vs stock by `security_type`, sign by `quantity`) rendered via `formatCombinedExposurePresence`.

- [ ] **Step 4: Parity test**

Extend the presence-position parity test so the mirrored region including the new function is asserted byte-identical.

- [ ] **Step 5: Run everything + commit**

Run: `npx vitest run tests/digest/ workers/cron/test/ && npx tsc --noEmit 2>&1 | tail -3`
Expected: all PASS (especially: every existing no-dollar-leak assertion still holds — shorts must not introduce $ amounts).

```bash
git add lib/digest/send-earnings-email.ts scripts/snapshot-state-to-r2.ts workers/cron/src/presence-position.ts workers/cron/src/fallback-earnings.ts tests/ workers/cron/test/
git commit -m "fix(earnings): short positions surface in earnings emails — Mac + Worker, presence-only (B7)"
```

---

### Task 8: Full verification

**Files:** none new.

- [ ] **Step 1:** `npx vitest run` — full suite, report exact counts, no failures.
- [ ] **Step 2:** `npx tsc --noEmit 2>&1 | tail -3` — zero errors.
- [ ] **Step 3:** `npx next build 2>&1 | tail -5` — compiles clean.
- [ ] **Step 4:** Live read-only smoke: `npx tsx -e "import {config} from 'dotenv'; config({path:'.env.local'}); import('./lib/db').then(async ({db}) => { const {findEarningsCoverageGaps} = await import('./lib/calendar/coverage-guard'); console.log(JSON.stringify(findEarningsCoverageGaps(db), null, 2)); })"` — expect a JSON array against the real DB (list whatever it reports; `402340` appearing as `no_history` is expected and is the candidate for the ignored-symbols setting — do NOT modify data).
- [ ] **Step 5:** Report: counts, the smoke output, and the two post-merge operational steps (Worker `npx wrangler deploy` from `workers/cron/`; snapshot v8 appears at the next 2am run; DMG rebuild at session end).
