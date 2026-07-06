# Deferred-Items Batch Implementation Plan (Defense gated deferrals + Wave-1 review minors)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close out the seven deferred items from the two 2026-07-05 sessions: the Defense tab's three gated deferrals (API envelope, privacy bar width, signed theta bleed), the four evening-session accepted review minors, and a live E2E visual verification pass.

**Architecture:** Six small, independent code tasks (each self-contained with its own tests) plus a final browser E2E pass. No new subsystems — every task touches an existing module and follows its established pattern (cash-deploy's `{success,data}` envelope, the privacy-components client pattern, existing test-file helpers).

**Tech Stack:** Next.js 16 / TypeScript 5, better-sqlite3 (`:memory:` in tests), Vitest, agent-browser (Playwright MCP) for E2E.

## Global Constraints

- Work on branch `claude/deferred-items-batch` off `main` in the main checkout (no parallel session running; no worktree needed).
- Run the FULL suite `npx vitest run` before every commit; all ~3113+ tests must pass. Report the count.
- Task 3 touches `workers/cron/src/` (comment only) — still run `cd workers/cron && npx vitest run` for that task.
- Commit per task with descriptive messages. **Do NOT push or merge to main** — user confirms at session end.
- Never `parseFloat` CSV fields, never hardcode Claude model ids, always `COALESCE(s.multiplier, 1)` — standing repo rules (none should come up, but they bind).
- Dates in tests use the file's existing `TODAY` constants; never `new Date()` for domain dates.

---

### Task 1: Coverage-guard far-future event guard (`no_history` mislabel)

**Files:**
- Modify: `lib/calendar/coverage-guard.ts` (insert after line 138, `if (future) continue;`)
- Test: `tests/calendar/coverage-guard.test.ts`

**Interfaces:**
- Consumes: existing test helpers in the test file — `insertAccount(db)`, `insertSecurity(db, symbol)`, `insertHolding(db, acct, sec, qty)`, `insertEarningsEvent(db, symbol, dateStr, { superseded? })`; `TODAY = "2026-07-05"`.
- Produces: no signature changes. `findEarningsCoverageGaps` gains one suppression rule: any non-superseded future earnings event for the issuer family — even beyond the 45d look-ahead — means the name is covered (no gap of either kind).

Background: a family whose ONLY event sits beyond the 45-day horizon fails the `future` check (`BETWEEN today AND horizon`) AND the `last` check (`event_date <= today`) and is mislabeled `no_history`. Manual far-future entries are the real-world trigger. A scheduled event is also evidence of coverage for the `due_no_event` branch, so the guard suppresses both kinds (a "nothing scheduled" alert is simply false when something IS scheduled).

- [ ] **Step 1: Write the failing tests**

Add to the `findEarningsCoverageGaps` describe block in `tests/calendar/coverage-guard.test.ts`:

```ts
it("a far-future event (beyond the 45d horizon) suppresses the no_history mislabel", () => {
  const acct = insertAccount(db);
  const sec = insertSecurity(db, "SPCE");
  insertHolding(db, acct, sec, 10);
  insertEarningsEvent(db, "SPCE", "2026-09-15"); // 72d out — beyond LOOKAHEAD_DAYS
  // no past events at all — pre-fix this was kind "no_history"

  expect(findEarningsCoverageGaps(db, { today: TODAY })).toEqual([]);
});

it("a far-future event also suppresses due_no_event (a scheduled report IS coverage)", () => {
  const acct = insertAccount(db);
  const sec = insertSecurity(db, "ORCL");
  insertHolding(db, acct, sec, 25);
  insertEarningsEvent(db, "ORCL", "2026-03-01"); // 126d ago — due
  insertEarningsEvent(db, "ORCL", "2026-09-15"); // scheduled, beyond horizon

  expect(findEarningsCoverageGaps(db, { today: TODAY })).toEqual([]);
});

it("a superseded far-future event does NOT count as coverage", () => {
  const acct = insertAccount(db);
  const sec = insertSecurity(db, "SNOW");
  insertHolding(db, acct, sec, 15);
  insertEarningsEvent(db, "SNOW", "2026-09-15", { superseded: 1 }); // only event, superseded

  expect(findEarningsCoverageGaps(db, { today: TODAY })).toEqual([
    { symbol: "SNOW", kind: "no_history", lastEventDate: null, daysSinceLast: null },
  ]);
});
```

- [ ] **Step 2: Run tests to verify the first two fail**

Run: `npx vitest run tests/calendar/coverage-guard.test.ts`
Expected: 2 FAIL (SPCE reported as `no_history`, ORCL as `due_no_event`), superseded test PASS (already-correct behavior).

- [ ] **Step 3: Implement the guard**

In `lib/calendar/coverage-guard.ts`, directly after `if (future) continue;` (line 138):

```ts
    // A scheduled event BEYOND the look-ahead horizon still proves a source
    // covers the name (manual far-future entries). Without this, a family
    // whose only event is >LOOKAHEAD_DAYS out falls through both the future
    // check (BETWEEN today AND horizon) and the last-report check
    // (event_date <= today) and gets mislabeled "no_history".
    const farFuture = db
      .prepare(
        `SELECT 1 FROM calendar_events
          WHERE event_type = 'earnings'
            AND COALESCE(superseded, 0) = 0
            AND event_date > ?
            AND UPPER(symbol) IN (${placeholders})
          LIMIT 1`,
      )
      .get(horizon, ...family);
    if (farFuture) continue;
```

- [ ] **Step 4: Run the file's tests, then the full suite**

Run: `npx vitest run tests/calendar/coverage-guard.test.ts` → all PASS.
Run: `npx vitest run` → all PASS (report count).

- [ ] **Step 5: Commit**

```bash
git add lib/calendar/coverage-guard.ts tests/calendar/coverage-guard.test.ts
git commit -m "fix(coverage-guard): far-future scheduled event counts as coverage (no_history mislabel)"
```

---

### Task 2: Pin the `fetchedAt`-absent push path + make the payload field optional

**Files:**
- Modify: `lib/calendar/cloud-reconcile.ts:18` (type only)
- Test: `tests/calendar/cloud-reconcile.test.ts`

**Interfaces:**
- Consumes: test-file helpers `seedHeldSecurity(symbol)`, `insertCalendarEvent({symbol, actual_value})`, `mockWorker({...})`, `mockSendEarningsPrintPush`.
- Produces: `CloudEnrichedPayload.fetchedAt` becomes `fetchedAt?: string` — aligning the type with the documented runtime tolerance (`isStalePayload` line 40: `if (!fetchedAt) return false` — missing means "treat as fresh, never suppress").

Background: old Worker payloads (pre-Wave-1) have no `fetchedAt`. The runtime already treats them as fresh (push proceeds), but no test pins it, and the interface claims the field is required — a future "cleanup" could break the tolerance silently.

- [ ] **Step 1: Write the test** (model: the "fires when the payload is fresh" test at line 261; omit `fetchedAt` entirely)

Add to the `push-at-print hook` describe block:

```ts
it("fires when the payload has NO fetchedAt (old Worker payload) — treated as fresh", async () => {
  seedHeldSecurity("OLDW");
  const eventId = insertCalendarEvent({ symbol: "OLDW", actual_value: null });

  mockWorker({
    [String(eventId)]: {
      eventId,
      source_key: "finnhub:OLDW:2026-07-28",
      actual: "EPS 0.95 · Rev 210,000,000",
      consensus: null,
      source: "cloud",
      reaction: null,
      // fetchedAt deliberately absent — pre-Wave-1 Worker payload shape
    },
  });

  await reconcileCloudEnrichment(db, "secret");

  expect(mockSendEarningsPrintPush).toHaveBeenCalledTimes(1);
});
```

If `mockWorker`'s payload parameter is typed as `CloudEnrichedPayload` and TypeScript rejects the omission, that is exactly why Step 3 makes the field optional — do Step 3 first in that case, then the test compiles.

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/calendar/cloud-reconcile.test.ts`
Expected: PASS immediately (behavior already correct — this is a pinning test). If it FAILS, stop: that's a real regression, investigate before proceeding.

- [ ] **Step 3: Make the type honest**

In `lib/calendar/cloud-reconcile.ts` line 18, change:

```ts
  fetchedAt: string;
```
to
```ts
  /** Absent on pre-Wave-1 Worker payloads — treated as fresh (see isStalePayload). */
  fetchedAt?: string;
```

- [ ] **Step 4: Full suite**

Run: `npx vitest run` → all PASS (report count). Also `npx tsc --noEmit` to confirm no consumer relied on the required field.

- [ ] **Step 5: Commit**

```bash
git add lib/calendar/cloud-reconcile.ts tests/calendar/cloud-reconcile.test.ts
git commit -m "test(print-push): pin fetchedAt-absent (old Worker payload) push path; fetchedAt now optional in type"
```

---

### Task 3: Mechanical pair — import hoist + subrequest-budget comment

**Files:**
- Modify: `lib/calendar/enrichment-runner.ts` (move mid-file imports at lines 484–489 to the top import block ending at line 19)
- Modify: `workers/cron/src/calendar-enrich.ts` (extend comment block at lines 317–321)

**Interfaces:** none — zero behavior change (ES imports are hoisted by the module system regardless of position; this is readability only).

- [ ] **Step 1: Hoist the imports**

In `lib/calendar/enrichment-runner.ts`: cut these two import statements from lines 484–489 (leave the explanatory comment block above them intact — it documents the email-candidate section, not the imports):

```ts
import { getSymbolStatus } from "@/lib/queries/briefing-symbols";
import {
  getEarningsSettings,
  shouldSendEarningsEmail,
} from "@/lib/queries/earnings-settings";
```

Paste them into the top import block, after line 19 (`import { sendEarningsPrintPush } from "@/lib/alerts/print-push";`).

- [ ] **Step 2: Add the subrequest-budget comment**

In `workers/cron/src/calendar-enrich.ts`, the push-at-print comment block (lines 317–321) ends with `muted list respected, issuer-family aware, KV-marker deduped.` — append one line to that block:

```ts
      // Costs up to 3 subrequests per print (marker read, Pushover POST,
      // marker write) against the invocation's 50-subrequest free-tier budget.
```

- [ ] **Step 3: Run both suites**

Run: `npx vitest run` → all PASS (report count).
Run: `cd workers/cron && npx vitest run` → all PASS.

- [ ] **Step 4: Commit**

```bash
git add lib/calendar/enrichment-runner.ts workers/cron/src/calendar-enrich.ts
git commit -m "chore(earnings): hoist mid-file imports in enrichment-runner; note push subrequest budget in calendar-enrich"
```

---

### Task 4: Signed theta bleed (retire `abs(theta)`)

**Files:**
- Modify: `lib/compute/hedging.ts:457` (+ doc comment on `HedgeScore.monthlyBleedPct` at line 441)
- Test: `tests/compute/hedging.test.ts` (the `scoreHedges` describe block, using the file's existing `hedgeInput({})` helper)

**Interfaces:**
- Consumes: `scoreHedges(inputs)` and the test file's `hedgeInput(overrides)` factory (defaults include `thetaPerDay: -10`, and a `protectedNotional` that produced `eff ≈ 11.1` for theta −30 → notional 10,000; check the factory at ~line 370–390 and reuse its defaults).
- Produces: `monthlyBleed = -thetaPerDay * 30` (signed). Long options (theta < 0) → positive bleed = cost, **numerically identical to the old `abs()` for every hedge that exists today**. Short options (theta > 0) → negative bleed = premium income; `expensive` badge can't fire (threshold is positive), `efficiency` stays null (existing `monthlyBleed > 0` guard — protection-per-dollar-of-decay is meaningless for a position that pays you).

- [ ] **Step 1: Write the failing test**

Add to the `scoreHedges` describe block:

```ts
it("short-option hedge (positive theta) reports negative bleed = income; no expensive badge; null efficiency", () => {
  const [s] = scoreHedges([hedgeInput({ thetaPerDay: 12 })]);
  expect(s.monthlyBleedPct).not.toBeNull();
  expect(s.monthlyBleedPct!).toBeLessThan(0); // collecting theta, not bleeding it
  expect(s.badges).not.toContain("expensive");
  expect(s.efficiency).toBeNull();
});

it("long-option bleed is unchanged by the sign convention (theta −10 → positive cost)", () => {
  const [s] = scoreHedges([hedgeInput({ thetaPerDay: -10 })]);
  expect(s.monthlyBleedPct!).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run to verify the first fails**

Run: `npx vitest run tests/compute/hedging.test.ts`
Expected: first test FAILS on `toBeLessThan(0)` (abs() forces positive); second PASSES.

- [ ] **Step 3: Implement**

In `lib/compute/hedging.ts` line 457, replace:

```ts
    const monthlyBleed = thetaPerDay !== null && protectedNotional > 0 ? Math.abs(thetaPerDay) * 30 : null;
```
with
```ts
    // Signed carry: theta < 0 (long options) decays — positive bleed = cost.
    // theta > 0 (a short-option hedge collecting premium) — negative bleed =
    // income; "expensive" then never fires and efficiency stays null via the
    // existing monthlyBleed > 0 guard. Identical output for all long hedges.
    const monthlyBleed = thetaPerDay !== null && protectedNotional > 0 ? -thetaPerDay * 30 : null;
```

And update the `HedgeScore` field doc at line 441 from bare `monthlyBleedPct: number | null;` context — give it:

```ts
  /** Monthly theta as a fraction of protected notional; negative = the hedge
   *  COLLECTS theta (short-option premium income), not a cost. */
  monthlyBleedPct: number | null;
```

- [ ] **Step 4: Run the file's tests, then the full suite**

Run: `npx vitest run tests/compute/hedging.test.ts` → all PASS.
Run: `npx vitest run` → all PASS (report count).

- [ ] **Step 5: Commit**

```bash
git add lib/compute/hedging.ts tests/compute/hedging.test.ts
git commit -m "fix(defense): theta bleed is signed — short-option hedges read as income, not cost"
```

---

### Task 5: Defense API `{success, data}` envelope

**Files:**
- Modify: `app/api/analysis/defense/route.ts`
- Create: `tests/api/analysis-defense.test.ts`

**Interfaces:**
- Consumes: `computeDefenseAnalysis(db, accountIds)` from `lib/compute/hedging`, `resolveScope(db, scope)` from `lib/queries/accounts`.
- Produces: `GET /api/analysis/defense?scope=` now returns `{ success: true, data: DefenseAnalysis }` on 200 and `{ success: false, error: string }` on 500 — byte-pattern-identical to `app/api/analysis/cash-deploy/route.ts`. Safe: `DefenseView` is a server component calling the compute directly; the route has zero in-app consumers today (it exists for external/mobile callers).

- [ ] **Step 1: Write the failing test** (model: `tests/api/analysis-drill-down.test.ts`)

Create `tests/api/analysis-defense.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/compute/hedging", () => ({ computeDefenseAnalysis: vi.fn() }));
vi.mock("@/lib/queries/accounts", () => ({ resolveScope: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {} as never }));

import { GET } from "@/app/api/analysis/defense/route";
import { computeDefenseAnalysis } from "@/lib/compute/hedging";
import { resolveScope } from "@/lib/queries/accounts";

function makeReq(qs: string) {
  return { nextUrl: new URL(`http://localhost/api/analysis/defense${qs}`) };
}

describe("GET /api/analysis/defense", () => {
  beforeEach(() => {
    vi.mocked(resolveScope).mockReturnValue([1]);
    vi.mocked(computeDefenseAnalysis).mockReturnValue({ summary: { hedgeCount: 2 } } as never);
  });

  it("wraps the analysis in the {success, data} envelope", async () => {
    const res = await GET(makeReq("?scope=vanguard") as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toEqual({ summary: { hedgeCount: 2 } });
  });

  it("returns {success:false, error} with 500 on compute failure", async () => {
    vi.mocked(computeDefenseAnalysis).mockImplementation(() => {
      throw new Error("boom");
    });
    const res = await GET(makeReq("?scope=all") as never);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe("boom");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/api/analysis-defense.test.ts`
Expected: FAIL — body has `summary` at top level, no `success` key.

- [ ] **Step 3: Implement the envelope**

Replace the body of `GET` in `app/api/analysis/defense/route.ts`:

```ts
export async function GET(req: NextRequest) {
  try {
    const scope = req.nextUrl.searchParams.get("scope");
    const accountIds = resolveScope(db, scope);
    return NextResponse.json({ success: true, data: computeDefenseAnalysis(db, accountIds) });
  } catch (err) {
    console.error("[api/analysis/defense]", err);
    const message = err instanceof Error ? err.message : "Failed to compute defense analysis";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
```

- [ ] **Step 4: Run the test, then the full suite**

Run: `npx vitest run tests/api/analysis-defense.test.ts` → PASS.
Run: `npx vitest run` → all PASS (report count).

- [ ] **Step 5: Commit**

```bash
git add app/api/analysis/defense/route.ts tests/api/analysis-defense.test.ts
git commit -m "feat(defense): align GET /api/analysis/defense to the {success,data} envelope (cash-deploy pattern)"
```

---

### Task 6: Sector-coverage bar width must not encode the ratio under privacy mode

**Files:**
- Create: `app/dashboard/components/CoverageBar.tsx`
- Modify: `app/dashboard/components/DefenseView.tsx:93-109` (replace the inline bar with the component; drop the `widthPct` computation)

**Interfaces:**
- Consumes: `usePrivacy()` from `@/lib/privacy/context` (returns `{ isPrivate: boolean, ... }`).
- Produces: `CoverageBar({ pct }: { pct: number | null })` — a client component. Normal mode: identical render to today (gold fill, width = clamped `pct*100`%). Privacy mode: uniform full-width fill at reduced opacity, so no cross-sector comparison is possible — visually consistent with the `•••` the adjacent `<Pct>` shows.

Background: `DefenseView` is a **server** component; privacy state lives in a client context, so the bar needs a small client leaf (same pattern as `<Money>`/`<Pct>` being client leaves inside server trees). No unit test — the repo has no component-render test pattern (no jsdom); verification is Task 7's E2E pass plus `npx next build`.

- [ ] **Step 1: Create the component**

`app/dashboard/components/CoverageBar.tsx`:

```tsx
"use client";

import { usePrivacy } from "@/lib/privacy/context";

/**
 * Sector-coverage fill bar for the Defense tab. Under privacy mode the bar
 * WIDTH must not encode the coverage ratio (portfolio-derived) — every bar
 * renders as a uniform full-width dimmed fill, matching the ••• shown by the
 * adjacent <Pct>. Client leaf because privacy state is a client context;
 * the parent DefenseView stays a server component.
 */
export function CoverageBar({ pct }: { pct: number | null }) {
  const { isPrivate } = usePrivacy();
  const widthPct = Math.min(100, Math.max(0, (pct ?? 0) * 100));
  return (
    <div className="h-2 rounded-full bg-raised overflow-hidden">
      <div
        className={`h-full rounded-full bg-gold${isPrivate ? " opacity-30" : ""}`}
        style={{ width: isPrivate ? "100%" : `${widthPct}%` }}
      />
    </div>
  );
}
```

- [ ] **Step 2: Use it in DefenseView**

In `app/dashboard/components/DefenseView.tsx`: add `import { CoverageBar } from "./CoverageBar";` beside the other component imports; inside the `sectorCoverage.map`, delete the line `const widthPct = Math.min(100, Math.max(0, (sc.coveragePct ?? 0) * 100));` and replace the bar markup

```tsx
                  <div className="h-2 rounded-full bg-raised overflow-hidden">
                    <div
                      className="h-full rounded-full bg-gold"
                      style={{ width: `${widthPct}%` }}
                    />
                  </div>
```
with
```tsx
                  <CoverageBar pct={sc.coveragePct} />
```

(The arrow-function body no longer needs braces/`return` if the only statement left is the JSX — simplify only if it stays readable.)

- [ ] **Step 3: Type-check and full suite**

Run: `npx tsc --noEmit` → clean.
Run: `npx vitest run` → all PASS (report count).

- [ ] **Step 4: Commit**

```bash
git add app/dashboard/components/CoverageBar.tsx app/dashboard/components/DefenseView.tsx
git commit -m "fix(defense): sector-coverage bar width no longer encodes the ratio under privacy mode"
```

---

### Task 7: E2E visual pass (privacy masking + bar behavior + envelope, on the dev server)

**Files:** none (verification only; findings reported back).

**Interfaces:**
- Consumes: everything Tasks 4–6 shipped, plus the pre-existing `4a2bc65` PrivateText fix that was never visually verified.

- [ ] **Step 1: Ensure a dev server is running on :3000**

Run: `curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://localhost:3000/dashboard/today`
If not 200: start `npm run dev` in the background (from the main checkout — it now has all six tasks) and wait for ready. Do NOT use :3099 — that's the packaged Electron app running last night's build.

- [ ] **Step 2: Dispatch agent-browser with this checklist**

Navigate `http://localhost:3000/dashboard/analysis?view=defense` and verify, screenshotting before/after the privacy toggle (the eye icon in the header):

1. **Privacy OFF baseline:** protection-ratio strip renders a %, interpretation prose visible, sector bars have differing widths, hedge table shows $ values.
2. Toggle privacy ON.
3. **Interpretation prose masks** (the `4a2bc65` deferred spot-check): the sentence under "Protection ratio" must be masked (`•••`-style), not readable prose.
4. **All portfolio-derived numbers mask:** Pct/Money/Count in the headline strip and tables → `•••`.
5. **Sector bars are uniform:** every bar full-width and dimmed — no bar visually longer than another.
6. **Envelope:** `fetch("/api/analysis/defense?scope=all")` from the page (or curl) → JSON has top-level `success: true` and `data` keys.
7. Toggle privacy OFF again — bars return to differing widths (regression check of the LightweightCharts-style "re-apply on state change" trap; plain CSS here, but confirm reactivity).

- [ ] **Step 3: Report**

Summarize pass/fail per check with screenshots. Any failure → stop and fix before the batch is declared done (max 2 fix attempts per the global rule, then stop and consult).

---

## Self-Review Notes

- **Coverage:** 7 deferred items → Task 1 (no_history guard), Task 2 (fetchedAt test), Task 3 (import hoist + subrequest comment — two items), Task 4 (abs-theta), Task 5 (envelope), Task 6 (bar width), Task 7 (PrivateText visual spot-check + verification of 4–6). All seven covered.
- **Type consistency:** `CoverageBar({ pct: number | null })` matches `sc.coveragePct`'s nullable type; `fetchedAt?: string` matches `isStalePayload(fetchedAt: string | undefined)`; envelope test mocks match real signatures (`resolveScope(db, scope) → number[]`).
- **No placeholders:** every code step carries the actual code; test helpers verified against the real test files (helper names + `TODAY` constants read from source).
