# End-of-Day Earnings Wrap (#17) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On days where ≥3 recap emails would fire in the same release slot (BMO/AMC), suppress the individual recaps and send ONE stapled wrap email per slot — on the Mac sweep and the Worker cloud fallback both.

**Architecture:** New pure cluster module (`lib/earnings/wrap.ts`) decides wrap mode + readiness; a wrap-send module (`lib/earnings/wrap-send.ts`) claims each event via the existing migration-063 claim mutex, composes each name with the EXISTING compose-only seam `composeEarningsEmail` (it already exists — no extraction needed), staples, sends once, and writes one audit row per event so the viewer/chips work unchanged. `runEarningsEmailSweep` gains a suppression branch + a wrap pass. The Worker mirrors the count/suppress/staple logic over snapshot + KV data.

**Tech Stack:** TypeScript, better-sqlite3 (`:memory:` tests), Vitest, existing earnings pipeline (claim mutex, KV markers, Resend).

**Spec:** `docs/superpowers/specs/2026-07-16-eod-earnings-wrap-design.md`

## Global Constraints

- `WRAP_THRESHOLD = 3` (constant, not a setting).
- Slot deadlines (user-set): **BMO 12:00 ET, AMC 20:00 ET** — ET wall-clock via `Intl.DateTimeFormat("en-US", { timeZone: "America/New_York" })`, NEVER the local clock.
- TBD-slot events never join a cluster.
- Dedup markers: **per-event markers only** (`{mac,cloud}-sent-earnings-recap-{id}` + running markers) — the wrap sets/checks them for every member exactly like an individual send. This deviates from the spec's extra cluster-level marker pair: the per-event markers already close the race and keep the sent-by-cloud audit backfill working with zero changes. (Spec deviation approved in-plan; note it in the PR/commit.)
- Muting the reporter symbol excludes it from both count and wrap.
- All DB functions take `db` as a parameter; case-insensitive symbol compares; `COALESCE(superseded,0)=0` everywhere.
- Run `npx vitest run` (full Mac suite) and `cd workers/cron && npx vitest run` before finishing any task; `npx tsc --noEmit` both roots at the end of each task.

---

### Task 1: Pure cluster logic — `lib/earnings/wrap.ts`

**Files:**
- Create: `lib/earnings/wrap.ts`
- Test: `tests/earnings/wrap.test.ts`

**Interfaces:**
- Consumes: `getEarningsForWeekDeduped` (lib/queries/calendar), `getSymbolStatus` (lib/queries/briefing-symbols), `getEarningsSettings`/`shouldSendEarningsEmail` (lib/queries/earnings-settings), `mondayOf` (lib/calendar/date-utils).
- Produces (used by Tasks 2–3):
  - `WRAP_THRESHOLD: 3`
  - `type WrapSlot = "BMO" | "AMC"`
  - `wrapSlotFor(e: { event_time: string | null; title: string | null; release_time: string | null }): WrapSlot | null` (null = TBD, never clusters)
  - `interface WrapClusterMember { eventId: number; symbol: string; releaseTime: string | null; ready: boolean }`
  - `getExpectedRecapCluster(db, date: string, slot: WrapSlot): WrapClusterMember[]` — held/watchlist, family-deduped, unskipped, unmuted, recap-unsent (rows with `error='in_progress'` count as members but a completed/cloud-sent row excludes)
  - `slotDeadlinePassed(slot: WrapSlot, now: Date): boolean`
  - `etHHMM(now: Date): string` (exported for the Worker mirror test)

- [ ] **Step 1: Write the failing tests**

```ts
// tests/earnings/wrap.test.ts
/**
 * EOD wrap cluster logic (#17).
 * Spec: docs/superpowers/specs/2026-07-16-eod-earnings-wrap-design.md
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  WRAP_THRESHOLD,
  wrapSlotFor,
  getExpectedRecapCluster,
  slotDeadlinePassed,
} from "@/lib/earnings/wrap";
import { setMutedEarningsSymbols } from "@/lib/queries/earnings-settings";

const TODAY = "2026-07-16";
let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedHeld(symbol: string): number {
  const sec = Number(
    db.prepare(`INSERT INTO securities (symbol, name, security_type) VALUES (?, ?, 'Stock')`)
      .run(symbol, symbol).lastInsertRowid,
  );
  const acct = Number(
    db.prepare(`INSERT INTO accounts (name) VALUES (?)`).run(`a-${symbol}`).lastInsertRowid,
  );
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
     VALUES (?, ?, 100, '2026-07-15', ?)`,
  ).run(acct, sec, `t:${symbol}`);
  return sec;
}

function seedEvent(opts: {
  symbol: string;
  releaseTime?: string | null;
  eventTime?: string | null;
  actual?: string | null;
  enrichedAt?: string | null;
  date?: string;
  superseded?: number;
}): number {
  return Number(
    db.prepare(
      `INSERT INTO calendar_events
        (source, event_type, event_date, event_time, release_time, title, symbol,
         actual_value, enriched_at, source_key, week_of, superseded)
       VALUES ('finnhub', 'earnings', ?, ?, ?, ?, ?, ?, ?, ?, '2026-07-13', ?)`,
    ).run(
      opts.date ?? TODAY,
      opts.eventTime ?? null,
      opts.releaseTime === undefined ? "16:15" : opts.releaseTime,
      `${opts.symbol} earnings`,
      opts.symbol,
      opts.actual ?? null,
      opts.enrichedAt ?? null,
      `finnhub:${opts.symbol}:${opts.date ?? TODAY}`,
      opts.superseded ?? 0,
    ).lastInsertRowid,
  );
}

describe("wrapSlotFor", () => {
  it("BMO/AMC from event_time marker, title phrase, then release_time; TBD → null", () => {
    expect(wrapSlotFor({ event_time: "bmo", title: null, release_time: null })).toBe("BMO");
    expect(wrapSlotFor({ event_time: null, title: "X earnings (After Market Close)", release_time: null })).toBe("AMC");
    expect(wrapSlotFor({ event_time: null, title: null, release_time: "08:00" })).toBe("BMO");
    expect(wrapSlotFor({ event_time: null, title: null, release_time: "16:15" })).toBe("AMC");
    expect(wrapSlotFor({ event_time: null, title: null, release_time: null })).toBeNull();
  });
});

describe("getExpectedRecapCluster", () => {
  it("counts held AMC reporters with readiness flags", () => {
    for (const s of ["AAA", "BBB", "CCC"]) seedHeld(s);
    seedEvent({ symbol: "AAA", actual: "EPS 1.00", enrichedAt: "2026-07-16 18:20:00" });
    seedEvent({ symbol: "BBB" }); // not ready
    seedEvent({ symbol: "CCC", actual: "EPS 2.00" }); // actual but not enriched → not ready

    const cluster = getExpectedRecapCluster(db, TODAY, "AMC");
    expect(cluster).toHaveLength(3);
    expect(cluster.find((m) => m.symbol === "AAA")!.ready).toBe(true);
    expect(cluster.find((m) => m.symbol === "BBB")!.ready).toBe(false);
    expect(cluster.find((m) => m.symbol === "CCC")!.ready).toBe(false);
  });

  it("excludes: non-held, other slot, skipped, muted, recap-sent, superseded; in_progress claims stay members", () => {
    for (const s of ["HELD1", "HELD2", "SKIP1", "MUTED", "SENT1", "CLAIM"]) seedHeld(s);
    seedEvent({ symbol: "HELD1" });
    seedEvent({ symbol: "HELD2", releaseTime: "08:00" }); // BMO — other slot
    seedEvent({ symbol: "NOPOS" }); // not held
    seedEvent({ symbol: "GONE", superseded: 1 });
    const skipId = seedEvent({ symbol: "SKIP1" });
    db.prepare(`INSERT INTO earnings_email_skips (event_id, phase) VALUES (?, 'recap')`).run(skipId);
    seedEvent({ symbol: "MUTED" });
    setMutedEarningsSymbols(db, ["MUTED"]);
    const sentId = seedEvent({ symbol: "SENT1" });
    db.prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at) VALUES (?, 'recap', 'x', datetime('now'))`,
    ).run(sentId);
    const claimId = seedEvent({ symbol: "CLAIM" });
    db.prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, error, claim_token)
       VALUES (?, 'recap', 'x', datetime('now'), 'in_progress', 'tok')`,
    ).run(claimId);

    const cluster = getExpectedRecapCluster(db, TODAY, "AMC");
    expect(cluster.map((m) => m.symbol).sort()).toEqual(["CLAIM", "HELD1"]);
  });

  it("family-dedupes cross-source rows (one member per print)", () => {
    seedHeld("GOOG");
    seedEvent({ symbol: "GOOGL" });
    db.prepare(
      `INSERT INTO calendar_events (source, event_type, event_date, release_time, title, symbol, source_key, week_of)
       VALUES ('nasdaq', 'earnings', ?, '16:15', 'GOOGL earnings', 'GOOGL', 'nasdaq:GOOGL:2026-07-16', '2026-07-13')`,
    ).run(TODAY);
    expect(getExpectedRecapCluster(db, TODAY, "AMC")).toHaveLength(1);
  });
});

describe("slotDeadlinePassed", () => {
  // 2026-07-16 is EDT (UTC-4): 12:00 ET = 16:00Z, 20:00 ET = 00:00Z next day.
  it("BMO deadline is 12:00 ET", () => {
    expect(slotDeadlinePassed("BMO", new Date("2026-07-16T15:59:00Z"))).toBe(false);
    expect(slotDeadlinePassed("BMO", new Date("2026-07-16T16:00:00Z"))).toBe(true);
  });
  it("AMC deadline is 20:00 ET", () => {
    expect(slotDeadlinePassed("AMC", new Date("2026-07-16T23:59:00Z"))).toBe(false);
    expect(slotDeadlinePassed("AMC", new Date("2026-07-17T00:00:00Z"))).toBe(true);
  });
});

describe("WRAP_THRESHOLD", () => {
  it("is 3", () => expect(WRAP_THRESHOLD).toBe(3));
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/earnings/wrap.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `lib/earnings/wrap.ts`**

```ts
/**
 * EOD earnings-wrap cluster logic (#17) — pure decisions only; the send
 * lives in lib/earnings/wrap-send.ts.
 *
 * A (date, slot) cluster is in WRAP MODE when its expected-unsent recap
 * count reaches WRAP_THRESHOLD. Expected = held/watchlist (family-aware),
 * family-deduped, not superseded/skipped/muted, recap not completed.
 * An 'in_progress' claim row keeps the event a member (someone is sending
 * it — usually the wrap itself mid-flight).
 *
 * Spec: docs/superpowers/specs/2026-07-16-eod-earnings-wrap-design.md
 */

import type Database from "better-sqlite3";
import { mondayOf } from "@/lib/calendar/date-utils";
import { getEarningsForWeekDeduped } from "@/lib/queries/calendar";
import { getSymbolStatus } from "@/lib/queries/briefing-symbols";
import { getEarningsSettings, shouldSendEarningsEmail } from "@/lib/queries/earnings-settings";

export const WRAP_THRESHOLD = 3;

export type WrapSlot = "BMO" | "AMC";

// User-set deadlines (2026-07-16): the wrap fires no later than these, in
// ET wall-clock. Worker mirror must match (fallback-earnings).
export const SLOT_DEADLINES_ET: Record<WrapSlot, string> = {
  BMO: "12:00",
  AMC: "20:00",
};

/** Same precedence as the cockpit's laneFor / the digest block's slotFor. */
export function wrapSlotFor(e: {
  event_time: string | null;
  title: string | null;
  release_time: string | null;
}): WrapSlot | null {
  const marker = `${e.event_time ?? ""} ${e.title ?? ""}`.toUpperCase();
  if (marker.includes("BMO") || marker.includes("BEFORE MARKET")) return "BMO";
  if (marker.includes("AMC") || marker.includes("AFTER MARKET")) return "AMC";
  if (e.release_time) return e.release_time < "12:00" ? "BMO" : "AMC";
  return null; // TBD — never clusters
}

export interface WrapClusterMember {
  eventId: number;
  symbol: string;
  releaseTime: string | null;
  /** Recap-ready: actual captured AND enrichment stamped complete. */
  ready: boolean;
}

export function getExpectedRecapCluster(
  db: Database.Database,
  date: string,
  slot: WrapSlot,
): WrapClusterMember[] {
  const events = getEarningsForWeekDeduped(db, mondayOf(date)).filter(
    (e) => e.event_date === date && e.symbol && wrapSlotFor(e) === slot,
  );
  if (events.length === 0) return [];

  const status = getSymbolStatus(db, events.map((e) => e.symbol!));
  const settings = getEarningsSettings(db);

  const ids = events.map((e) => e.id);
  const ph = ids.map(() => "?").join(",");
  const sentRecaps = new Set(
    (db.prepare(
      `SELECT event_id FROM earnings_emails
        WHERE phase = 'recap' AND event_id IN (${ph})
          AND (error IS NULL OR error = 'sent-by-cloud')`,
    ).all(...ids) as { event_id: number }[]).map((r) => r.event_id),
  );
  const skipped = new Set(
    (db.prepare(
      `SELECT event_id FROM earnings_email_skips
        WHERE phase = 'recap' AND event_id IN (${ph})`,
    ).all(...ids) as { event_id: number }[]).map((r) => r.event_id),
  );

  return events
    .filter((e) => {
      const st = status[e.symbol!.toUpperCase()];
      if (st !== "held" && st !== "watchlist") return false;
      if (sentRecaps.has(e.id) || skipped.has(e.id)) return false;
      if (!shouldSendEarningsEmail(settings, e.symbol!)) return false;
      return true;
    })
    .map((e) => ({
      eventId: e.id,
      symbol: e.symbol!.toUpperCase(),
      releaseTime: e.release_time ?? null,
      ready: e.actual_value != null && e.enriched_at != null,
    }));
}

export function etHHMM(now: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).format(now);
}

export function slotDeadlinePassed(slot: WrapSlot, now: Date): boolean {
  // Intl with hour12:false can render midnight as "24:00" — normalize.
  const hhmm = etHHMM(now).replace(/^24/, "00");
  return hhmm >= SLOT_DEADLINES_ET[slot];
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run tests/earnings/wrap.test.ts` → all PASS. Careful check: the AMC-deadline-at-midnight-UTC case (00:00Z = 20:00 ET) must pass — if the "24:00" normalization trips, fix before proceeding.

- [ ] **Step 5: Commit** — `git add lib/earnings/wrap.ts tests/earnings/wrap.test.ts && git commit -m "feat(earnings): EOD wrap cluster logic — per-slot expected-recap clusters, ET deadlines (#17 T1)"`

---

### Task 2: Wrap send — `lib/earnings/wrap-send.ts`

**Files:**
- Create: `lib/earnings/wrap-send.ts`
- Test: `tests/earnings/wrap-send.test.ts`

**Interfaces:**
- Consumes (Task 1): `getExpectedRecapCluster`, `slotDeadlinePassed`, `WRAP_THRESHOLD`, `WrapSlot`, `WrapClusterMember`.
- Consumes (existing): `composeEarningsEmail`, `claimEarningsEmailSlot`, `releaseEarningsEmailClaim`, `EarningsEmailError`, `renderHeadlineTable` (all from `@/lib/digest/send-earnings-email`), `sendEmail` (`@/lib/email`), `briefingToHtml` (`@/lib/calendar/briefing-html`), `checkEarningsCloudMarker`/`setEarningsRunningMarker`/`clearEarningsRunningMarker`/`writeMacSentEarningsMarker` (`@/lib/cron/earnings-marker-check`).
- Produces: `runWrapPass(db, opts: { now?: Date; recipient?: string }): Promise<WrapPassResult>` where `WrapPassResult = { wrapsSent: number; wrapped: number; stillWaiting: string[] }` — called by Task 3 from `runEarningsEmailSweep` AFTER the candidate loop.
- Audit rows are written via the SAME upsert shape `recordEarningsEmailAudit` uses; since that function is module-private, wrap-send performs the identical upsert inline (copy the SQL from `lib/digest/send-earnings-email.ts:435` region) with `ai_output_md` = the per-name section markdown.

**Behavioral contract (each is a test):**
1. Cluster below threshold → no-op.
2. Cluster ≥3 all ready → claims each (skips any claim conflict → aborts THIS tick, releases taken claims), composes each via `composeEarningsEmail(db, id, "recap")`, staples `# {SYM}` sections under a combined scoreboard index, sends ONE email `subject: "📊 Earnings wrap — {slot} {date} ({N} names)"`, writes one audit row per event, writes per-event mac-sent markers.
3. Deadline passed with 1 blocked member → wrap sends the ready ones + "Still waiting on actuals: SYMBOL" line; blocked member gets NO audit row (its individual recap fires later).
4. Deadline NOT passed and not all ready → no-op (waiting).
5. One compose failure (mock `composeEarningsEmail` rejecting for one id) → that name renders scoreboard + "compose failed" note, wrap still sends, and that event's claim is RELEASED (no audit row) so its individual recap can retry.
6. Per-event cloud-sent marker present for a member → that member is treated as sent (excluded; `recordCloudSentAudit` equivalence is Task 3's sweep-level concern — here just exclude).
7. Mute/skip/sent exclusions are Task 1's job — wrap-send trusts the cluster.

**Implementation notes (exact):**
- Mock seams in tests: `vi.mock("@/lib/digest/send-earnings-email", async (importOriginal) => ({ ...(await importOriginal()), composeEarningsEmail: vi.fn() }))` and `vi.mock("@/lib/email", () => ({ sendEmail: vi.fn() }))`; marker helpers mocked to no-op resolves (AI-mocking memory pattern).
- Compose result stub shape: `{ symbol, title: "SYM Earnings Recap — …", markdown, aiMarkdown, html, promptHash }` — the wrap staples `aiMarkdown` per name and rebuilds ONE html via `briefingToHtml(stapledMarkdown)`.
- Scoreboard index: for each ready member fetch its event row and call `renderHeadlineTable(event, symbol, "recap")` before the per-name sections.
- Release-order: sort members by `releaseTime ?? "99:99"` then symbol.
- `recipient` default `process.env.BRIEFING_EMAIL_TO` (same 400-style guard as sendEarningsEmail — throw `EarningsEmailError(…, 400)` when missing).
- Never throws out of `runWrapPass` on send failure: catch → release all fresh claims → log → return `{ wrapsSent: 0, … }` (the sweep must not fail; next tick retries).

- [ ] **Step 1: Write the failing tests** (all 6 contract cases above, in-memory DB seeded like Task 1's fixtures).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement `runWrapPass` per the contract.**
- [ ] **Step 4: Run to verify pass; run `npx vitest run tests/earnings/` for neighbors.**
- [ ] **Step 5: Commit** — `git commit -m "feat(earnings): wrap send — claim, staple, single email, per-event audit rows (#17 T2)"`

---

### Task 3: Sweep integration — suppression + wrap pass

**Files:**
- Modify: `lib/calendar/email-sweep.ts` (candidate loop + after-loop wrap pass; extend `SweepCandidateResult.skipped` union with `"wrap-pending"`; extend `SweepSummary` with `wrapsSent: number`)
- Test: `tests/calendar/email-sweep.test.ts` (extend existing file)

**Interfaces:**
- Consumes: Task 1 (`getExpectedRecapCluster`, `wrapSlotFor`, `WRAP_THRESHOLD`), Task 2 (`runWrapPass`).
- Produces: sweep behavior — no signature changes for callers (`/api/cron/earnings-sweep`, `scripts/sweep-earnings-emails.ts` read `SweepSummary`; additive field only).

**Exact changes:**
1. In the candidate loop, before the cloud-marker check, for `cand.phase === "recap"` only: load the candidate's event row (`SELECT event_date, event_time, title, release_time FROM calendar_events WHERE id = ?`), compute `slot = wrapSlotFor(row)`; if `slot !== null` and `getExpectedRecapCluster(db, row.event_date, slot).length >= WRAP_THRESHOLD` → push `{ ok: true, skipped: "wrap-pending" }` result and `continue`. (Previews are untouched.)
2. After the loop (before `alertBlockedRecaps`): `const wrap = await runWrapPass(db, { now: opts.now }); summary.wrapsSent = wrap.wrapsSent;` — `runWrapPass` internally evaluates BOTH slots for `todayET(opts.now)`.
3. Tests to add (mock `sendEarningsPreview/Recap` + `runWrapPass` module seams like the existing suite does):
   - 3 ready AMC recap candidates → all three results are `skipped: "wrap-pending"`, `sendEarningsRecap` never called, `runWrapPass` called once.
   - 2 candidates (below threshold) → individual sends happen, no suppression.
   - Preview candidates never suppressed.

- [ ] **Step 1: Write the failing tests.**
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Full Mac suite + `npx tsc --noEmit` → green.**
- [ ] **Step 5: Commit** — `git commit -m "feat(earnings): sweep suppresses wrap-mode recaps + runs the wrap pass (#17 T3)"`

---

### Task 4: Worker mirror — count, suppress, staple, gate extension

**Files:**
- Modify: `workers/cron/src/fallback-earnings.ts` (cluster count + suppression + wrap staple in `runEarningsFallback`)
- Modify: `workers/cron/src/calendar-enrich.ts:128` (`shouldRunEarningsFallback` window 05:00–20:00 → 05:00–**20:59** ET — required so the 20:00 AMC deadline tick can fire cloud-side; B8 18:00→18:59 precedent)
- Test: `workers/cron/test/fallback-earnings.test.ts` (extend), `workers/cron/test/calendar-enrich.test.ts` (gate boundary)

**Interfaces:**
- Consumes: snapshot `calendarEvents` + `earningsEmails` + `earningsSettings` + KV `cloud-enriched-*` payloads (readiness) + `{mac,cloud}-sent-earnings-recap-*` markers — all existing.
- Produces: cloud wrap email via existing `sendEmail(env, …)`; per-event `cloud-sent-earnings-recap-{id}` markers written for every wrapped name (audit backfill unchanged).

**Mirror rules (each a test):**
1. Pure helpers duplicated in fallback-earnings: `wrapSlotForCloud(event)` (same precedence — reuse the file's existing hour parsing if equivalent), `cloudSlotDeadlinePassed(slot, nowMs)` using the file's existing ET helpers; deadlines `{ BMO: "12:00", AMC: "20:00" }` — add a comment pinning parity with `lib/earnings/wrap.ts::SLOT_DEADLINES_ET`.
2. Expected-unsent cluster from snapshot events (held/watchlist family-aware — the file already builds these sets), minus events with a sent audit row in `snapshot.earningsEmails`, minus mac/cloud sent markers, minus muted.
3. Cluster ≥3 → individual cloud recap candidates in that cluster are NOT sent this tick; if (all ready via KV payloads with actuals) OR deadline → compose stapled email from the existing compact per-name renderer, ONE `sendEmail`, write per-event cloud-sent markers. `MAX_CANDIDATES_PER_RUN=5` caps the staple size (closest releases first, rest defer + `console.warn`, markerless so next tick retries — B13 rule).
4. Below threshold → existing behavior byte-identical (regression pin: run the existing fallback-earnings tests unmodified).
5. Gate: `shouldRunEarningsFallback` boundary tests — 20:30 ET Tuesday → true; 21:15 ET → false.

- [ ] **Step 1: Write the failing tests (gate boundary first — smallest).**
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement gate extension, then cluster/suppress/staple.**
- [ ] **Step 4: Worker suite + `npx tsc --noEmit` (workers/cron) → green.**
- [ ] **Step 5: Commit** — `git commit -m "feat(worker): cloud EOD wrap mirror — count, suppress, staple, 20:59 gate (#17 T4)"`

---

### Task 5: Docs + whole-feature verification

**Files:**
- Modify: `CLAUDE.md` (earnings email sweep bullet: add wrap semantics — per-slot ≥3 suppress-and-staple, deadlines 12:00/20:00 ET, per-event markers/audit unchanged, TBD never wraps, late-finisher sends individually)
- Modify: `docs/superpowers/specs/2026-07-16-eod-earnings-wrap-design.md` (record the per-event-markers-only deviation)

- [ ] **Step 1: Update both docs.**
- [ ] **Step 2: Full verification** — repo root: `npx vitest run` AND `npx tsc --noEmit`; workers/cron: same. All green.
- [ ] **Step 3: Live smoke (read-only)** — `npx tsx -e` script: call `getExpectedRecapCluster` against `data/vanguard.db` for today AMC (expect NFLX only → below threshold → no wrap today) and `slotDeadlinePassed("AMC", new Date())` — sanity print.
- [ ] **Step 4: Commit** — `git commit -m "docs(earnings): EOD wrap conventions + spec deviation note (#17 T5)"`
