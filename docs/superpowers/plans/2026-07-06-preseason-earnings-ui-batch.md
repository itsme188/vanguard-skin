# Pre-Season Earnings + UI Polish Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining pre-earnings-season items before the 7/14 week: B19 sign-flip plausibility, B20 Worker issuerSiblings held-check, the WeekAheadView privacy unmask, the Classification-card mobile overflow, and all six "accepted review minors" from the 2026-07-04 audit.

**Architecture:** Small, independent fixes to existing single-source modules — no new subsystems. Each task is a surgical change with TDD where a unit seam exists, plus one final browser-E2E verification pass that also reconciles the QA findings ledger.

**Tech Stack:** Next.js 16 / TypeScript 5 / better-sqlite3 / Vitest (root app + separate `workers/cron` vitest package).

## Global Constraints

- All dates `YYYY-MM-DD`; "today" is always `todayET()`, never UTC.
- Case-insensitive symbol/type comparisons everywhere (`.toUpperCase()` before Set membership).
- Never symbol-string-equal on user-visible surfaces — `issuerSiblings()` first (CLAUDE.md dual-class rule).
- Macro calendar rows keep **single-shot** enrichment semantics EXACTLY (CLAUDE.md migration-062 rule) — the new reaction gate must apply to earnings rows only.
- Privacy masks **portfolio-derived** values only; consensus/actual/macro prints are public market data (B16 rule).
- Worker mirrors change in lockstep with Mac sources; parity tests pin them.
- Root tests: `npx vitest run` (from repo root). Worker tests: `cd workers/cron && npx vitest run`.
- Run the FULL root suite before every commit (repo Workflow Rule); do not commit on red.
- Do NOT push — the user authorizes push at session end.
- Migration files are numbered `.sql` in `lib/db/migrations/`; next free number is **063**.

---

### Task 1: B19 — sign-flipped actuals fail plausibility

**Files:**
- Modify: `lib/digest/send-earnings-email.ts:1388-1412` (`isPlausibleEarnings`)
- Test: `tests/digest/read-throughs.test.ts` (existing `isPlausibleEarnings` describe block around lines 531-582)

**Interfaces:**
- Consumes: nothing new.
- Produces: same signature `isPlausibleEarnings(consensusEps, actualEps, consensusRev, actualRev): boolean` — all three consumers (read-throughs `:593`, `renderHeadlineTable` `:1015-1021`, `EarningsHub.actualsAreImplausible`) inherit the new rejection automatically.

- [x] **Step 1: Write the failing tests** — add to the existing `isPlausibleEarnings` describe block in `tests/digest/read-throughs.test.ts`:

```ts
it("rejects sign-flipped EPS — GAAP/FFO basis mismatch (B19)", () => {
  // Real last-season cases: U reported +0.23 vs consensus −0.24;
  // LAND reported +0.08 vs consensus −0.23 (FFO basis).
  expect(isPlausibleEarnings(-0.24, 0.23, null, null)).toBe(false);
  expect(isPlausibleEarnings(-0.23, 0.08, null, null)).toBe(false);
  expect(isPlausibleEarnings(0.5, -0.1, null, null)).toBe(false);
});

it("still accepts same-sign results and zero edges", () => {
  expect(isPlausibleEarnings(0.5, 0.6, null, null)).toBe(true);
  expect(isPlausibleEarnings(-0.5, -0.4, null, null)).toBe(true); // both negative: no ratio guard (cons>0), no sign flip
  expect(isPlausibleEarnings(0, 0.1, null, null)).toBe(true); // zero consensus carries no sign signal
  expect(isPlausibleEarnings(0.5, 0, null, null)).toBe(true); // zero actual likewise
});
```

- [x] **Step 2: Run to verify failure**

Run: `npx vitest run tests/digest/read-throughs.test.ts`
Expected: FAIL — the three sign-flip expectations return `true` today.

- [x] **Step 3: Implement** — insert at the top of `isPlausibleEarnings`, before the existing EPS ratio check:

```ts
  // B19: an EPS sign flip between actual and consensus is a basis mismatch
  // (GAAP vs adjusted / FFO — U +0.23 vs cons −0.24 last season) far more
  // often than a genuine loss↔profit surprise. Better no number than a
  // wrong-basis one; POST /api/earnings/actuals is the manual override.
  if (
    consensusEps != null && actualEps != null &&
    consensusEps !== 0 && actualEps !== 0 &&
    Math.sign(consensusEps) !== Math.sign(actualEps)
  ) {
    return false;
  }
```

- [x] **Step 4: Run to verify pass**

Run: `npx vitest run tests/digest/read-throughs.test.ts`
Expected: PASS.

- [x] **Step 5: Full suite + commit**

Run: `npx vitest run` — expected all green. Then:

```bash
git add lib/digest/send-earnings-email.ts tests/digest/read-throughs.test.ts
git commit -m "fix(earnings): B19 — sign-flipped actuals (GAAP/FFO basis mismatch) fail plausibility"
```

---

### Task 2: B20 — Worker fallback held-check walks issuerSiblings (+ mute case-fix + watchlist coverage)

**Files:**
- Modify: `workers/cron/src/fallback-earnings.ts:262-285` (`findCandidatesFromSnapshot`)
- Test: `workers/cron/test/fallback-earnings.test.ts`

**Interfaces:**
- Consumes: `issuerSiblings` already defined/exported in the SAME file at line 89; `snapshot.watchlistSymbols?: string[]` (snapshot v8, `workers/cron/src/state.ts:247`).
- Produces: no signature changes.

**Background:** the correct family-walk template already exists in this Worker at `workers/cron/src/calendar-enrich.ts:331-340` (push-at-print gate). The parity pin for the families data already exists (`workers/cron/test/issuer-family-parity.test.ts`) — no new parity test needed.

- [x] **Step 1: Write the failing tests** — in `workers/cron/test/fallback-earnings.test.ts`, reuse the existing `makeEnv()` / `makeEarningsSnapshot()` / `previewWindowNow()` helpers. The snapshot builder returns `as unknown as Snapshot`, so additive fields are fine:

```ts
describe("B20: issuer-family aware held/watchlist/mute gates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (sendEmail as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "mock-email-id" });
  });

  function snapshotWith(overrides: {
    heldSymbols?: string[]; watchlistSymbols?: string[]; mutedSymbols?: string[]; eventSymbol?: string;
  }) {
    const snap = makeEarningsSnapshot() as any;
    snap.heldSymbols = overrides.heldSymbols ?? [];
    if (overrides.watchlistSymbols) snap.watchlistSymbols = overrides.watchlistSymbols;
    if (overrides.mutedSymbols) snap.earningsSettings = { enabled: true, mutedSymbols: overrides.mutedSymbols };
    if (overrides.eventSymbol) snap.calendarEvents[0].symbol = overrides.eventSymbol;
    return snap;
  }

  it("GOOGL event with only GOOG held is a candidate (family walk)", async () => {
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      snapshotWith({ heldSymbols: ["GOOG"], eventSymbol: "GOOGL" }),
    );
    const result = await runEarningsFallback(makeEnv(), previewWindowNow());
    expect(sendEmail).toHaveBeenCalled();
    expect(result.sent).toBeGreaterThan(0);
  });

  it("watchlist-only symbol is a candidate (snapshot v8 parity with push-at-print)", async () => {
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      snapshotWith({ heldSymbols: [], watchlistSymbols: ["AAPL"] }),
    );
    const result = await runEarningsFallback(makeEnv(), previewWindowNow());
    expect(sendEmail).toHaveBeenCalled();
  });

  it("mute list is case-insensitive and family-aware", async () => {
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      snapshotWith({ heldSymbols: ["GOOG"], eventSymbol: "GOOGL", mutedSymbols: ["goog"] }),
    );
    await runEarningsFallback(makeEnv(), previewWindowNow());
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
```

Adapt assertion details (`result.sent` vs result shape) to how the existing tests in that file assert — follow the file's own patterns.

- [x] **Step 2: Run to verify failure**

Run: `cd workers/cron && npx vitest run test/fallback-earnings.test.ts`
Expected: FAIL — GOOGL/watchlist candidates are dropped; muted lowercase passes through.

- [x] **Step 3: Implement** — in `findCandidatesFromSnapshot` (`fallback-earnings.ts`), replace lines 263-264:

```ts
    const heldSet = new Set(snapshot.heldSymbols.map((s) => s.toUpperCase()));
    const watchSet = new Set(
      (snapshot.watchlistSymbols ?? []).map((s) => s.toUpperCase()),
    );
    const muted = new Set(
      (snapshot.earningsSettings?.mutedSymbols ?? []).map((s) => s.toUpperCase()),
    );
```

and replace the loop gates at lines 283-285:

```ts
      const sym = e.symbol.toUpperCase();
      // B20: family walk so a GOOGL event with GOOG held isn't dropped, plus
      // watchlist coverage (snapshot v8 ships watchlistSymbols; older
      // snapshots degrade to held-only via ?? []). Mirrors the push-at-print
      // gate in calendar-enrich.ts.
      const family = issuerSiblings(sym).map((s) => s.toUpperCase());
      if (!family.some((f) => heldSet.has(f) || watchSet.has(f))) continue;
      if (family.some((f) => muted.has(f))) continue;
```

- [x] **Step 4: Run to verify pass**

Run: `cd workers/cron && npx vitest run`
Expected: full Worker suite PASS (including the existing issuer-family parity pin).

- [x] **Step 5: Commit**

```bash
git add workers/cron/src/fallback-earnings.ts workers/cron/test/fallback-earnings.test.ts
git commit -m "fix(worker): B20 — cloud earnings fallback held-check walks issuerSiblings + watchlist + case-safe mute"
```

Note for the session driver: the Worker needs a `wrangler deploy` at session end for this to take effect in the cloud (Mac-side tasks don't).

---

### Task 3: WeekAheadView privacy unmask (B16 sibling)

**Files:**
- Modify: `app/dashboard/today/WeekAheadView.tsx:177-188`

**Interfaces:** none — display-only change.

- [x] **Step 1: Implement directly** (server component, no unit seam — browser E2E in Task 12 verifies). In `WeekAheadView.tsx`:

Replace lines 177-181:

```tsx
              {actualDisplay && (
                <span className="text-[11px] font-mono text-up bg-up/10 rounded px-1.5 py-0.5 ml-auto shrink-0 whitespace-nowrap">
                  actual {actualDisplay}
                </span>
              )}
```

Replace lines 184-188:

```tsx
              {consensusDisplay && !actualDisplay && (
                <p className="text-[12px] font-mono text-ink-faint mt-1.5 truncate">
                  Cons: {consensusDisplay}
                </p>
              )}
```

Add this comment above the `actualDisplay` render (the B16 rationale, mirroring `EarningsHub.tsx:405-409`):

```tsx
              {/* Consensus / actual values are PUBLIC market data (macro
                  prints, street EPS/Rev) — they reveal nothing about the
                  user's holdings, so they render unmasked per the
                  privacy-masks-portfolio-only rule (B16 sibling). */}
```

- [x] **Step 2: Clean the import** — check whether `PrivateText` is still used elsewhere in the file (`grep -n PrivateText app/dashboard/today/WeekAheadView.tsx`). If these were the only two usages, remove it from the line-5 import.

- [x] **Step 3: Typecheck + full suite + commit**

Run: `npx vitest run` — green. Then:

```bash
git add app/dashboard/today/WeekAheadView.tsx
git commit -m "fix(today): week-ahead EventCard renders public macro/earnings actuals unmasked under privacy mode (B16 sibling)"
```

---

### Task 4: ClassificationCard method-legend wrap (mobile overflow)

**Files:**
- Modify: `app/dashboard/components/analysis/ClassificationCard.tsx:148`

- [x] **Step 1: Implement** — change the legend row container (line 148):

```tsx
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3">
```

(was `flex gap-4 mt-3` — single unwrappable row extending to x=418 in a 384px viewport; deep-QA finding `analysis-diagnostics-mobile--breakdown-table-page-horizontal-overflow`, 2026-07-06 re-sighting.)

- [x] **Step 2: Full suite + commit**

```bash
npx vitest run
git add app/dashboard/components/analysis/ClassificationCard.tsx
git commit -m "fix(analysis): Classification method-legend row wraps at mobile widths (deep-QA overflow finding)"
```

---

### Task 5: Sweep maps 409s to `skipped`, not `failed`

**Files:**
- Modify: `lib/digest/send-earnings-email.ts:45-53` (`EarningsEmailError`), `:130-135` and `:186-191` (throw sites)
- Modify: `lib/calendar/email-sweep.ts:33-42` (`SweepCandidateResult`), `:121-132` (catch branch)
- Test: `tests/calendar/email-sweep.test.ts`

**Interfaces:**
- Produces: `EarningsEmailError` gains `public readonly code?: "claim_held" | "not_ready"` (third constructor arg). `SweepCandidateResult.skipped` union widens to `"cloud-already-sent" | "claim-held" | "not-ready"`.

- [x] **Step 1: Write the failing test** — in `tests/calendar/email-sweep.test.ts` (follow the file's existing fixture/mocking pattern for making a candidate; the simplest route is a candidate whose claim row is already held `in_progress` with a fresh `sent_at`):

```ts
it("counts a cross-process 409 claim refusal as skipped, not failed", async () => {
  // Arrange: one preview candidate whose (event_id, phase) claim row is
  // already held by "another process" (error='in_progress', sent_at=now).
  db.prepare(
    `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, error)
     VALUES (?, 'preview', 'other@proc.com', datetime('now'), 'in_progress')`,
  ).run(eventId);

  const summary = await runEarningsEmailSweep(db, sweepOpts);

  expect(summary.failed).toBe(0);
  expect(summary.skipped).toBe(1);
  const r = summary.results.find((x) => x.eventId === eventId)!;
  expect(r.ok).toBe(true);
  expect(r.skipped).toBe("claim-held");
  expect(r.status).toBe(409);
});
```

- [x] **Step 2: Run to verify failure**

Run: `npx vitest run tests/calendar/email-sweep.test.ts`
Expected: FAIL — today `failed: 1, skipped: 0`.

- [x] **Step 3: Implement.** In `send-earnings-email.ts`:

```ts
export class EarningsEmailError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    /** Benign 409 coordination outcomes the sweep should log as skips. */
    public readonly code?: "claim_held" | "not_ready",
  ) {
    super(message);
    this.name = "EarningsEmailError";
  }
}
```

At the claim-refusal throw (`:186-191`) add `"claim_held"` as the third arg. At the recap-no-actual throw (`:130-135`) add `"not_ready"` as the third arg.

In `email-sweep.ts`, widen the type:

```ts
  skipped?: "cloud-already-sent" | "claim-held" | "not-ready";
```

and replace the catch branch body (`:121-132`):

```ts
    } catch (err) {
      const status = err instanceof EarningsEmailError ? err.status : 500;
      const message = err instanceof Error ? err.message : String(err);
      // Benign cross-process 409s (another process holds the claim; recap
      // actuals not ready) are coordination outcomes, not failures — season
      // launchd logs should read clean (2026-07-04 review minor).
      const benign409 = err instanceof EarningsEmailError && status === 409;
      results.push({
        eventId: cand.eventId,
        symbol: cand.symbol,
        phase: cand.phase,
        ok: benign409,
        skipped: benign409
          ? (err.code === "claim_held" ? "claim-held" : "not-ready")
          : undefined,
        status,
        message,
        durationMs: Date.now() - t0,
      });
    }
```

(TypeScript narrowing: inside the ternary `err` is already narrowed by `benign409`; if the compiler complains, hoist `const eErr = err instanceof EarningsEmailError ? err : null;` and branch on that.)

- [x] **Step 4: Run to verify pass**

Run: `npx vitest run tests/calendar/email-sweep.test.ts` then `npx vitest run`
Expected: PASS, full suite green.

- [x] **Step 5: Commit**

```bash
git add lib/digest/send-earnings-email.ts lib/calendar/email-sweep.ts tests/calendar/email-sweep.test.ts
git commit -m "fix(earnings): sweep logs benign 409s (claim held / not ready) as skipped, not failed"
```

---

### Task 6: Claim ownership token (migration 063)

**Files:**
- Create: `lib/db/migrations/063_earnings_email_claim_token.sql`
- Modify: `lib/digest/send-earnings-email.ts` (`claimEarningsEmailSlot`, `releaseEarningsEmailClaim`, the release call site at `:214`)
- Test: `tests/digest/earnings-email-claims.test.ts`

**Interfaces:**
- Produces: `claimEarningsEmailSlot` return gains `token?: string` (set whenever `mode === "fresh"`). `releaseEarningsEmailClaim(db, eventId, phase, token: string)` — token now REQUIRED (only caller is the `sendEarningsEmail` catch).

**Migration (show to user before running — per global rules it ships in this plan):**

```sql
-- 063: claim ownership token. A send claim held >30 min can be taken over by
-- a second process; without a token, the slow first process's failure-cleanup
-- DELETE could remove the successor's live claim (theoretical duplicate-send
-- opener — 2026-07-04 audit review minor). Claims now carry a per-claim UUID
-- and release is token-conditional. Reap is unchanged (it only targets claims
-- stale >30 min, which a live successor's refreshed sent_at can never be).
ALTER TABLE earnings_emails ADD COLUMN claim_token TEXT;
```

- [x] **Step 1: Write the failing test** — in `tests/digest/earnings-email-claims.test.ts`:

```ts
it("a late finisher's release cannot delete a successor's takeover claim", () => {
  const a = claimEarningsEmailSlot(db, eventId, "preview", "x@y.com");
  expect(a.claimed).toBe(true);
  expect(a.token).toBeTruthy();

  // Age A's claim past the 30-min stale cutoff, then B takes over.
  db.prepare(
    `UPDATE earnings_emails SET sent_at = datetime('now', '-31 minutes')
      WHERE event_id = ? AND phase = 'preview'`,
  ).run(eventId);
  const b = claimEarningsEmailSlot(db, eventId, "preview", "x@y.com");
  expect(b.claimed).toBe(true);
  expect(b.token).toBeTruthy();
  expect(b.token).not.toBe(a.token);

  // A fails late and releases with ITS token — B's claim must survive.
  releaseEarningsEmailClaim(db, eventId, "preview", a.token!);
  const row = db
    .prepare(
      `SELECT error, claim_token FROM earnings_emails WHERE event_id = ? AND phase = 'preview'`,
    )
    .get(eventId) as { error: string; claim_token: string };
  expect(row).toBeDefined();
  expect(row.error).toBe("in_progress");
  expect(row.claim_token).toBe(b.token);

  // B releasing with its own token works.
  releaseEarningsEmailClaim(db, eventId, "preview", b.token!);
  expect(
    db.prepare(`SELECT 1 FROM earnings_emails WHERE event_id = ?`).get(eventId),
  ).toBeUndefined();
});
```

Update the file's existing release tests to pass the claim's token.

- [x] **Step 2: Run to verify failure**

Run: `npx vitest run tests/digest/earnings-email-claims.test.ts`
Expected: FAIL (no `token` on claim result; release takes 3 args).

- [x] **Step 3: Implement.** Create the migration file exactly as above. In `send-earnings-email.ts` add `import { randomUUID } from "crypto";` and update:

```ts
export function claimEarningsEmailSlot(
  db: Database.Database,
  eventId: number,
  phase: "preview" | "recap",
  recipient: string,
): { claimed: boolean; mode: "fresh" | "refire"; token?: string; reason?: "in_progress" } {
  const token = randomUUID();
  const ins = db
    .prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, ai_input_hash, ai_output_md, error, claim_token)
       VALUES (?, ?, ?, datetime('now'), NULL, NULL, 'in_progress', ?)
       ON CONFLICT(event_id, phase) DO NOTHING`,
    )
    .run(eventId, phase, recipient, token);
  if (ins.changes === 1) return { claimed: true, mode: "fresh", token };

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
            SET sent_at = datetime('now'), recipient = ?, claim_token = ?
          WHERE event_id = ? AND phase = ? AND error = 'in_progress'
            AND datetime(sent_at) <= datetime('now', '-${CLAIM_STALE_MINUTES} minutes')`,
      )
      .run(recipient, token, eventId, phase);
    if (takeover.changes === 1) return { claimed: true, mode: "fresh", token };
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
  token: string,
): void {
  // Token-conditional: a late finisher must not delete a successor's
  // takeover claim (migration 063).
  db.prepare(
    `DELETE FROM earnings_emails
      WHERE event_id = ? AND phase = ? AND error = 'in_progress' AND claim_token = ?`,
  ).run(eventId, phase, token);
}
```

Update the release call site in `sendEarningsEmail` (`:214`):

```ts
    if (claim.mode === "fresh" && claim.token) {
      releaseEarningsEmailClaim(db, eventId, phase, claim.token);
    }
```

`reapStaleEarningsEmailClaims` is intentionally unchanged (see migration comment).

- [x] **Step 4: Run to verify pass**

Run: `npx vitest run tests/digest/earnings-email-claims.test.ts` then `npx vitest run`
Expected: PASS, full suite green (migration runner picks up 063 automatically in test DBs).

- [x] **Step 5: Commit**

```bash
git add lib/db/migrations/063_earnings_email_claim_token.sql lib/digest/send-earnings-email.ts tests/digest/earnings-email-claims.test.ts
git commit -m "fix(earnings): claim ownership token — late finisher's release can't delete a successor's claim (migration 063)"
```

---

### Task 7: Reaction-capture gate at T+115m — earnings rows only

**Files:**
- Modify: `lib/calendar/enrichment-runner.ts` (constants near `:34-42`; the capture block `:251-327`)
- Test: `tests/calendar/enrichment-runner.test.ts`

**Interfaces:**
- Produces: `export const REACTION_READY_MS = 115 * 60 * 1000;` (exported for tests).

**Why 115m:** `matchBarsToReaction` targets `t_post = release + 120min` and the TWS fetch window ends at release+125min — any attempt before ~T+115m is a guaranteed-empty TWS/Yahoo round, and earnings rows retry every 10-min tick anyway (migration 062). **Macro rows are single-shot and MUST keep capturing immediately** (their partial-bars reaction is by design; gating them would be a regression against the CLAUDE.md single-shot invariant).

- [x] **Step 1: Write the failing tests** — in `tests/calendar/enrichment-runner.test.ts`, following the file's existing mock pattern for `captureReactionFromTws` / `captureReactionFromYahoo`:

```ts
it("skips reaction capture for an earnings row before T+115m (retry tick covers it)", async () => {
  // Arrange: earnings candidate whose release was 30 minutes ago.
  // (Build via the file's existing insertEvent/candidate helpers with
  // source='finnhub', release_time 30 min in the past, actual already set
  // or fetchActual mocked.)
  await runEnrichment(db, { now, tws: mockTws });
  expect(captureReactionFromTws).not.toHaveBeenCalled();
  expect(captureReactionFromYahoo).not.toHaveBeenCalled();
  // And the row must NOT be stamped complete (enriched_at stays NULL).
});

it("still captures reaction immediately for a macro row (single-shot semantics)", async () => {
  // Arrange: macro candidate (source='fred:…', event_type != 'earnings'),
  // release 30 minutes ago.
  await runEnrichment(db, { now, tws: mockTws });
  expect(captureReactionFromTws).toHaveBeenCalled();
});

it("attempts earnings reaction capture once past T+115m", async () => {
  // Arrange: earnings candidate released 116 minutes before `now`.
  await runEnrichment(db, { now, tws: mockTws });
  expect(captureReactionFromTws).toHaveBeenCalled();
});
```

- [x] **Step 2: Run to verify failure**

Run: `npx vitest run tests/calendar/enrichment-runner.test.ts`
Expected: FAIL — capture is attempted at T+30m for earnings today.

- [x] **Step 3: Implement.** Near the other constants (`:34-42`):

```ts
// Reaction bars target t_post = release+120m (TWS fetch window ends at
// +125m) — any capture attempt before ~T+115m is a guaranteed-empty
// TWS/Yahoo round. Earnings rows retry every tick (migration 062) so they
// come back; macro rows are single-shot and are NEVER gated (their
// immediate partial capture is by design).
export const REACTION_READY_MS = 115 * 60 * 1000;
```

In the loop, hoist the earnings discriminator ABOVE the reaction block (it currently lives at `:311-312`) and gate both capture attempts:

```ts
      const isEarnings =
        event.source === "finnhub" || event.event_type === "earnings";
```

Inside the `if (releaseInstant)` block, before the TWS attempt:

```ts
          const captureAgeMs =
            (opts.now ?? new Date()).getTime() - releaseInstant.getTime();
          const reactionReady = !isEarnings || captureAgeMs >= REACTION_READY_MS;
```

Change the TWS attempt condition (`:280`) to `if (opts.tws && reactionReady)` and the Yahoo fallback condition (`:294`) to `if (!reaction && reactionReady)`. Remove the now-duplicate `const isEarnings = …` at `:311-312` (reuse the hoisted one). Completion logic is untouched: with capture skipped, `hasReaction` stays false and `ageMs < REACTION_READY_MS < REACTION_SETTLE_MS`, so `complete` stays false and the row retries — verify this reasoning holds when reading the code.

- [x] **Step 4: Run to verify pass**

Run: `npx vitest run tests/calendar/enrichment-runner.test.ts` then `npx vitest run`
Expected: PASS, full suite green.

- [x] **Step 5: Commit**

```bash
git add lib/calendar/enrichment-runner.ts tests/calendar/enrichment-runner.test.ts
git commit -m "perf(enrichment): skip earnings reaction capture before T+115m — bars can't exist yet (macro single-shot untouched)"
```

---

### Task 8: `alertBlockedRecaps` respects the mute list

**Files:**
- Modify: `lib/calendar/email-sweep.ts:182-238`
- Test: `tests/calendar/email-sweep.test.ts`

**Interfaces:**
- Consumes: `getEarningsSettings(db)` + `shouldSendEarningsEmail(settings, symbol)` from `lib/queries/earnings-settings.ts` (same pair `findEmailCandidates` uses at `enrichment-runner.ts:610-611`).

- [x] **Step 1: Write the failing test** — in `tests/calendar/email-sweep.test.ts` (the file already tests `alertBlockedRecaps`; extend with a muted case):

```ts
it("does not push a blocked-recap alert for a muted symbol, and does not stamp it", async () => {
  // Arrange: a previewed earnings event >2h past release with no actuals
  // (reuse the file's existing blocked-recap fixture), then mute the symbol:
  db.prepare(
    `INSERT INTO settings (key, value) VALUES ('earnings_emails_muted_symbols', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(JSON.stringify(["TER"]));

  const alerted = await alertBlockedRecaps(db, { now });
  expect(alerted).toBe(0);
  const row = db
    .prepare(`SELECT actual_missing_alerted_at FROM calendar_events WHERE id = ?`)
    .get(eventId) as { actual_missing_alerted_at: string | null };
  expect(row.actual_missing_alerted_at).toBeNull(); // unmuting re-enables the alert
});
```

(Verify the exact settings key/shape `getEarningsSettings` reads — `lib/queries/earnings-settings.ts:47-56` — and match it in the fixture.)

- [x] **Step 2: Run to verify failure**

Run: `npx vitest run tests/calendar/email-sweep.test.ts`
Expected: FAIL — alert fires today for muted symbols.

- [x] **Step 3: Implement.** In `email-sweep.ts` add the import:

```ts
import { getEarningsSettings, shouldSendEarningsEmail } from "@/lib/queries/earnings-settings";
```

In `alertBlockedRecaps`, read settings once before the loop and skip muted rows BEFORE stamping:

```ts
  const settings = getEarningsSettings(db);

  let alerted = 0;
  for (const row of rows) {
    // Respect the mute list (user decision 2026-07-06): a symbol muted after
    // its preview went out shouldn't push blocked-recap alerts. Deliberately
    // NO stamp — unmuting while the event is still inside the age window
    // re-enables the alert on the next tick.
    if (!shouldSendEarningsEmail(settings, row.symbol)) continue;
    const release = composeReleaseInstant(row.event_date, row.release_time);
    ...
```

- [x] **Step 4: Run to verify pass**

Run: `npx vitest run tests/calendar/email-sweep.test.ts` then `npx vitest run`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add lib/calendar/email-sweep.ts tests/calendar/email-sweep.test.ts
git commit -m "fix(earnings): blocked-recap Pushover respects the muted-symbols setting"
```

---

### Task 9: Delete the dead per-event cron routes

**Files:**
- Delete: `app/api/cron/earnings-preview/route.ts`, `app/api/cron/earnings-recap/route.ts` (and their now-empty directories)
- Modify: `CLAUDE.md` (the API-pattern bullet documenting `POST /api/cron/earnings-preview` + `POST /api/cron/earnings-recap`, around line 349)

**Verified 2026-07-06:** repo-wide grep (scripts/, workers/, docs/launchd/, *.sh, *.plist, all source) found ZERO runtime callers — the launchd wrapper `scripts/enrich-calendar-events.sh` curls only `/api/calendar/enrich` + `/api/cron/earnings-sweep`, and `email-sweep.ts`'s module header already calls the routes "(uncalled)". User approved deletion 2026-07-06.

- [x] **Step 1: Re-verify zero callers** (defense against drift since the audit):

```bash
grep -rn "cron/earnings-preview\|cron/earnings-recap" --include="*.ts" --include="*.tsx" --include="*.sh" --include="*.plist" --include="*.js" /Users/Yitzi/code/vanguard-skin | grep -v "app/api/cron/earnings-"
```

Expected: no output (CLAUDE.md/TODO prose matches are fine).

- [x] **Step 2: Delete + doc cleanup**

```bash
git rm -r app/api/cron/earnings-preview app/api/cron/earnings-recap
```

In `CLAUDE.md`, replace the `POST /api/cron/earnings-preview` + `POST /api/cron/earnings-recap` API bullet with a one-line tombstone appended to the `/api/cron/earnings-sweep` bullet: `(The per-event routes /api/cron/earnings-{preview,recap} were deleted 2026-07-06 — dead code superseded by the sweep; the marker dance lives in email-sweep.ts.)`

Check whether `lib/cron/earnings-marker-check.ts` exports anything ONLY those routes consumed (`checkEarningsCloudMarker`, `setEarningsRunningMarker`, etc. are all used by `email-sweep.ts` — verify with grep before removing anything; expected outcome: nothing else to delete).

- [x] **Step 3: Build + full suite + commit**

Run: `npx next build` (route deletion is exactly the class of change tests don't catch) and `npx vitest run`.

```bash
git add CLAUDE.md
git commit -m "chore(earnings): delete dead per-event cron routes — superseded by the shared sweep"
```

---

### Task 10: `sector_etf_gaps` — fix the Healthcare vocabulary bug + reprocess the backlog

**Files:**
- Modify: `lib/calendar/reaction-snapshot.ts:70-97` (`SECTOR_TO_ETF` + `resolveSectorEtf`)
- Create: `scripts/reprocess-sector-etf-gaps.ts`
- Test: `tests/calendar/` — whichever existing file covers `resolveSectorEtf` (grep; if none, add cases to `tests/calendar/enrichment-runner.test.ts`)

**Root cause (verified):** `SECTOR_TO_ETF` keys `"Health Care"` but the canonical GICS vocabulary (`lib/securities/normalize-sector.ts::GICS_SECTORS`) is `"Healthcare"` — every Healthcare earnings name has logged a gap forever. All other 10 keys match the canonical list.

- [x] **Step 1: Check for a Worker mirror first**

```bash
grep -rn "SECTOR_TO_ETF\|Health Care" /Users/Yitzi/code/vanguard-skin/workers/cron/src/
```

If the Worker cloud-enrich path has its own copy of the map, apply the identical key fix there and note it in the commit message.

- [x] **Step 2: Write the failing test**

```ts
it("resolves the canonical GICS 'Healthcare' label to XLV (vocabulary-drift fix)", () => {
  expect(resolveSectorEtf("earnings", "Healthcare")).toBe("XLV");
});
it("resolves legacy pre-normalizer labels via normalizeSector defense", () => {
  expect(resolveSectorEtf("earnings", "Health Care")).toBe("XLV");
  expect(resolveSectorEtf("earnings", "Financial")).toBe("XLF");
});
```

- [x] **Step 3: Run to verify failure**

Run: `npx vitest run tests/calendar/`
Expected: the `"Healthcare"` case FAILS today.

- [x] **Step 4: Implement.** In `reaction-snapshot.ts`, change line 73 to the canonical key and route the lookup through the normalizer defensively:

```ts
import { normalizeSector } from "@/lib/securities/normalize-sector";
```

```ts
  "Healthcare":             "XLV",
```

```ts
export function resolveSectorEtf(
  eventType: string,
  securitySector: string | null,
): string | null {
  if (eventType === "earnings" && securitySector) {
    // Defensive normalize: securities.sector is canonical GICS post-2026-06-09,
    // but legacy rows / raw vendor strings may still arrive here.
    const canonical = normalizeSector(securitySector) ?? securitySector;
    return SECTOR_TO_ETF[canonical] ?? null;
  }
  const fromMap = EVENT_SECTOR_MAP[eventType];
  return fromMap ?? null;
}
```

(If the Worker mirror exists and can't import the Mac normalizer, give the mirror the key fix only and add a code comment; check whether an existing parity test pins this map.)

- [x] **Step 5: Write the reprocess script** — create `scripts/reprocess-sector-etf-gaps.ts`:

```ts
/**
 * Reprocess the sector_etf_gaps backlog (2026-07-04 audit review minor).
 *
 * For each gap row: read the symbol's CURRENT securities.sector, resolve it
 * through resolveSectorEtf (now normalizer-defended). Rows that resolve are
 * stale — the sector was unmappable at enrichment time (pre-GICS-normalizer
 * spelling, or the SECTOR_TO_ETF "Health Care" key bug) but maps fine now.
 * Deleting them means future events for that symbol enrich with the ETF and
 * the data-health panel shows only GENUINE gaps.
 *
 * Historical events are NOT re-enriched: their reaction windows are long
 * past (Yahoo keeps ~10 days of 1-min bars) and enrichment is ADD-only.
 *
 * Dry-run by default; pass --apply to delete.
 */
import Database from "better-sqlite3";
import { resolveSectorEtf } from "../lib/calendar/reaction-snapshot";

const db = new Database("data/vanguard.db");
const apply = process.argv.includes("--apply");

const gaps = db
  .prepare(
    `SELECT g.symbol, g.sector AS gap_sector, g.count, s.sector AS current_sector
       FROM sector_etf_gaps g
       LEFT JOIN securities s
         ON UPPER(s.symbol) = UPPER(g.symbol) AND LOWER(s.security_type) != 'option'
      GROUP BY g.symbol, g.sector`,
  )
  .all() as Array<{ symbol: string; gap_sector: string | null; count: number; current_sector: string | null }>;

let resolvable = 0;
for (const g of gaps) {
  const etf = resolveSectorEtf("earnings", g.current_sector);
  const status = etf ? `RESOLVABLE → ${etf}` : "still unmapped";
  console.log(
    `${g.symbol.padEnd(8)} gap-sector=${String(g.gap_sector).padEnd(24)} current=${String(g.current_sector).padEnd(24)} ${status}`,
  );
  if (etf) {
    resolvable += 1;
    if (apply) {
      db.prepare(`DELETE FROM sector_etf_gaps WHERE symbol = ? AND ((sector IS NULL AND ? IS NULL) OR sector = ?)`)
        .run(g.symbol, g.gap_sector, g.gap_sector);
    }
  }
}
console.log(
  `\n${gaps.length} gap rows; ${resolvable} resolvable${apply ? " — DELETED" : " (dry run; pass --apply to delete)"}.`,
);
db.close();
```

(Adapt the securities join if a symbol has multiple non-option rows — pick any with a non-null sector: implementer verifies against the live table shape.)

- [x] **Step 6: Run the script against the live DB** — dry-run first, review the output, then `--apply`:

```bash
npx tsx scripts/reprocess-sector-etf-gaps.ts
npx tsx scripts/reprocess-sector-etf-gaps.ts --apply
```

Report before/after row counts (`SELECT COUNT(*) FROM sector_etf_gaps`).

- [x] **Step 7: Full suite + commit**

```bash
npx vitest run
git add lib/calendar/reaction-snapshot.ts scripts/reprocess-sector-etf-gaps.ts tests/
git commit -m "fix(enrichment): SECTOR_TO_ETF 'Health Care'→'Healthcare' vocabulary drift + normalizer defense + gap-backlog reprocess script"
```

---

### Task 11: Full verification pass

- [x] **Step 1:** `npx vitest run` from repo root — record the total count (baseline was 3151; expect it higher).
- [x] **Step 2:** `cd workers/cron && npx vitest run` — all green.
- [x] **Step 3:** `npx next build` — clean compile (route deletion + import changes verified).

No commit — this is the gate for Task 12.

---

### Task 12: Browser E2E + QA-ledger reconciliation + TODO reconcile

**Files:**
- Modify: `qa/findings/ledger.json`, `qa/findings/FINDINGS.md` (status annotations)
- Modify: `docs/plans/TODO.md` (close the shipped items)

- [x] **Step 1: Start the dev server** (user preference — also lets the iPhone see changes):

```bash
npm run dev
```

(background; wait for "Ready".)

- [x] **Step 2: Browser E2E via agent-browser** (parallel agents fine, per user preference). Verify at `http://localhost:3000`:

1. **Privacy (Task 3):** `/dashboard/today?view=week-ahead`, toggle privacy ON (header eye icon). A macro row with an actual (or consensus) shows the real value, NOT `•••`; meanwhile a portfolio-derived number elsewhere on Today still masks (regression check).
2. **390×844 overflow sweep** (`documentElement.scrollWidth === clientWidth` on each):
   - `/dashboard/analysis?view=diagnostics` scrolled to Classification (Task 4 fix)
   - `/dashboard/alerts` (already-fixed in code — verify + flip ledger)
   - `/dashboard/charts` (already-fixed — verify + flip)
   - Chat overlay empty-state via bottom-nav (already-fixed — verify + flip)

- [x] **Step 3: Reconcile the QA ledger.** For each of the four overflow findings (`alerts-inbox-mobile--filter-tabs-and-actions-overflow-390px`, `analysis-diagnostics-mobile--breakdown-table-page-horizontal-overflow`, `charts-mobile--horizontal-overflow-390px`, `mobile-chat--empty-state-welcome-panel-overflows-viewport`): if E2E confirmed clean, set status `fixed` in `qa/findings/ledger.json` with a note naming the fixing commit (this batch's commit for Diagnostics; the prior qa-deep-fixes merges for the other three), and update the matching FINDINGS.md entries. Any that still overflow: report back instead of flipping.

- [x] **Step 4: TODO.md reconcile.** Mark shipped: B19/B20 (line ~233), the review-minors line (~234) — noting the two decided-away items (`per-event routes deleted`, `mute respected`) — and the B16-sibling EventCard item (line 30). Add a one-line session block per the file's convention.

- [x] **Step 5: Final commit**

```bash
npx vitest run
git add qa/findings/ docs/plans/TODO.md
git commit -m "chore(qa): flip verified mobile-overflow findings + TODO reconcile for pre-season batch"
```

---

## Self-Review Notes

- **Coverage:** B19 → Task 1; B20 → Task 2; EventCard privacy → Task 3; mobile-overflow batch → Tasks 4 + 12 (three of four findings were already fixed in code by the 2026-07-06 QA-harvest merges — verification + ledger flip is the remaining work); review minors → Tasks 5 (409→skipped), 6 (claim token), 7 (reaction gate), 8 (mute), 9 (route deletion), 10 (sector_etf_gaps). All six minors covered.
- **Type consistency:** `claim.token?: string` (Task 6) matches the `releaseEarningsEmailClaim(db, eventId, phase, token)` call site; `EarningsEmailError.code` (Task 5) values `"claim_held" | "not_ready"` match the sweep's mapping; `REACTION_READY_MS` exported for Task 7's tests.
- **Deliberate scope exclusions:** no re-enrichment of historical events in Task 10 (reaction windows long past; enrichment is ADD-only); reap logic untouched in Task 6 (successor's refreshed `sent_at` protects it by construction); macro rows never gated in Task 7.
