# B8 Cloud Recap Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Worker earnings-recap fallback deliver correct same-day cloud recaps when the Mac is asleep, and make it impossible for it to send a wrong/empty recap or suppress the Mac's rich one.

**Architecture:** The recap candidate scan gains a second road — reading the `cloud-enriched-{eventId}` KV payloads that Phase 9b cloud-enrich already writes — and cloud-enrich gains earnings-only retry-until-complete (Worker mirror of Mac migration 062), a T+115 reaction gate, a 12h earnings window, and an 18:59 ET gate so AMC reactions become capturable. Safety gates (actual-required, no consensus-as-actual, consensus precedence, plausibility) mirror the Mac; a stricter "at least one real data point" rule governs sends. Shared payload contract moves to a new `cloud-enriched.ts` module to avoid a circular import.

**Tech Stack:** Cloudflare Worker (TypeScript, `workers/cron/`), vitest (Worker: `cd workers/cron && npx vitest run`; Mac: `npx vitest run` at repo root), wrangler.

**Spec:** `docs/superpowers/specs/2026-07-07-b8-cloud-recap-parity-design.md` — read it before starting.

## Global Constraints

- Worker code cannot import across the Next.js path-alias boundary — Mac↔Worker sharing is done via byte-parity hand-copies pinned by parity tests (see `workers/cron/test/print-push-message.test.ts` for the convention).
- Macro calendar rows keep single-shot enrichment semantics EXACTLY — only earnings rows (`event_type === "earnings" || source_key.startsWith("finnhub:")`) get retry/gating changes.
- Never send an earnings email outside the existing fallback loop's marker dance (check markers → send → write `cloud-sent`), and never write a `cloud-sent` marker for an email that wasn't sent.
- Mac behavior must not change except the `isPlausibleEarnings` file move (behavior-neutral, re-exported).
- No new dependencies. All new Worker functions that tests need are `export`ed.
- Worker test commands run from `workers/cron/`: `npx vitest run test/<file>.test.ts`. Mac suite from repo root: `npx vitest run`.
- Commit after every task (git user runs commits; messages given per task).

---

### Task 1: Extract `isPlausibleEarnings` to `lib/earnings/plausibility.ts` (Mac, behavior-neutral)

**Files:**
- Create: `lib/earnings/plausibility.ts`
- Modify: `lib/digest/send-earnings-email.ts` (remove the function at lines ~1390-1437, add re-export)
- Test: existing `tests/digest/read-throughs.test.ts` (no changes — it is the safety net)

**Interfaces:**
- Consumes: nothing.
- Produces: `isPlausibleEarnings(consensusEps: number | null, actualEps: number | null, consensusRev: number | null, actualRev: number | null): boolean` importable from `@/lib/earnings/plausibility` AND (re-export) from `@/lib/digest/send-earnings-email`. Task 2 copies this file byte-for-byte below the header.

- [ ] **Step 1: Create the new file**

Create `lib/earnings/plausibility.ts`. The header comment is above the function; everything from `export function isPlausibleEarnings` down is the parity-pinned region (Task 2's mirror strips at that anchor). Copy the function **verbatim** from `lib/digest/send-earnings-email.ts` (search for `export function isPlausibleEarnings` — it is the block ending with the revenue ratio guard `if (ratio >= 1.4 || ratio <= 0.7) return false;` followed by `return true;`). Do NOT retype it — copy it, including its full doc comment starting `/**\n * Reject a Finnhub-sourced earnings row…`.

```ts
/**
 * Earnings plausibility guard — single source, ZERO imports by design.
 *
 * The Worker mirror (workers/cron/src/plausibility.ts) is a byte-parity hand
 * copy below this header, pinned by workers/cron/test/plausibility-parity.test.ts
 * (same convention as print-push-message / presence-position / editions).
 * Never add an import here; change both files together.
 */

// <the verbatim doc comment + isPlausibleEarnings function body go here>
```

- [ ] **Step 2: Replace the function in `send-earnings-email.ts` with a re-export**

Delete the entire function (doc comment included) from `lib/digest/send-earnings-email.ts` and add at the same spot:

```ts
// Moved to lib/earnings/plausibility.ts (zero-import single source with a
// byte-parity Worker mirror). Re-exported so existing importers are untouched.
export { isPlausibleEarnings } from "@/lib/earnings/plausibility";
```

- [ ] **Step 3: Run the Mac suites that exercise it**

Run: `npx vitest run tests/digest/read-throughs.test.ts tests/digest/`
Expected: PASS — `isPlausibleEarnings` describe block (incl. B19 sign-flip cases) green via the re-export.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add lib/earnings/plausibility.ts lib/digest/send-earnings-email.ts
git commit -m "refactor(earnings): extract isPlausibleEarnings to zero-import lib/earnings/plausibility.ts (B8 prep)"
```

---

### Task 2: Worker plausibility mirror + parity test

**Files:**
- Create: `workers/cron/src/plausibility.ts`
- Create: `workers/cron/test/plausibility-parity.test.ts`

**Interfaces:**
- Consumes: `lib/earnings/plausibility.ts` (Task 1) as the parity source.
- Produces: `isPlausibleEarnings(...)` importable from `../src/plausibility` in Worker code (Task 7 consumes it).

- [ ] **Step 1: Write the failing parity test**

Create `workers/cron/test/plausibility-parity.test.ts` (convention copied from `print-push-message.test.ts`):

```ts
/**
 * Parity tests for workers/cron/src/plausibility.ts — a byte-for-byte hand
 * copy of lib/earnings/plausibility.ts below the header (Worker can't cross
 * the Next.js path-alias boundary).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { isPlausibleEarnings } from "../src/plausibility";

describe("plausibility parity (Worker mirror of lib/earnings/plausibility.ts)", () => {
  it("is byte-identical to the Mac source below the header", () => {
    const mac = readFileSync(
      new URL("../../../lib/earnings/plausibility.ts", import.meta.url),
      "utf8",
    );
    const wkr = readFileSync(new URL("../src/plausibility.ts", import.meta.url), "utf8");
    const strip = (s: string) => s.slice(s.indexOf("/**\n * Reject a Finnhub-sourced"));
    expect(strip(wkr)).toBe(strip(mac));
  });

  // Behavior pins mirrored from tests/digest/read-throughs.test.ts.
  it("accepts in-line and genuine-beat prints", () => {
    expect(isPlausibleEarnings(null, null, null, null)).toBe(true);
    expect(isPlausibleEarnings(2.7, 2.62, 110_000_000_000, 109_900_000_000)).toBe(true);
    expect(isPlausibleEarnings(2.09, 2.68, 7_067_819_551, 7_874_790_000)).toBe(true); // PWR +28%
  });

  it("rejects ratio-implausible actuals", () => {
    expect(isPlausibleEarnings(2.7, 5.11, null, null)).toBe(false); // GOOGL bogus
    expect(isPlausibleEarnings(2.0, 0.5, null, null)).toBe(false);
    expect(isPlausibleEarnings(null, null, 100_000_000, 145_000_000)).toBe(false);
  });

  it("rejects EPS sign flips (B19 basis mismatch)", () => {
    expect(isPlausibleEarnings(-0.24, 0.23, null, null)).toBe(false); // U
    expect(isPlausibleEarnings(-0.23, 0.08, null, null)).toBe(false); // LAND
  });

  it("passes a genuine $0.00 actual (no ratio claim)", () => {
    expect(isPlausibleEarnings(1.5, 0, null, null)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd workers/cron && npx vitest run test/plausibility-parity.test.ts`
Expected: FAIL — cannot resolve `../src/plausibility`.

- [ ] **Step 3: Create the mirror**

Create `workers/cron/src/plausibility.ts`: a Worker header comment, then **byte-identical content** from `lib/earnings/plausibility.ts` starting at the `/**\n * Reject a Finnhub-sourced` doc comment (copy the file and replace only the top header block):

```ts
/**
 * Byte-parity hand copy of lib/earnings/plausibility.ts (below this header) —
 * the Worker can't cross the Next.js path-alias boundary. Pinned by
 * test/plausibility-parity.test.ts. Change BOTH files together.
 */

// <verbatim from lib/earnings/plausibility.ts starting at the function's doc comment>
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd workers/cron && npx vitest run test/plausibility-parity.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add workers/cron/src/plausibility.ts workers/cron/test/plausibility-parity.test.ts
git commit -m "feat(worker): isPlausibleEarnings byte-parity mirror + parity test (B8)"
```

---

### Task 3: Shared `cloud-enriched.ts` module (payload contract + completeness)

**Files:**
- Create: `workers/cron/src/cloud-enriched.ts`
- Modify: `workers/cron/src/calendar-enrich.ts` (delete local `cloudEnrichedKey` + `CloudEnrichedPayload`, import + re-export from the new module)
- Test: `workers/cron/test/cloud-enriched.test.ts` (create)

**Interfaces:**
- Consumes: `WorkerEnrichActualResult` type from `./enrich-actuals`.
- Produces (Tasks 5–7 rely on these exact names):
  - `interface CloudEnrichedPayload { eventId: number; source_key: string; actual: string | null; consensus: string | null; source: WorkerEnrichActualResult["source"]; deferred?: boolean; reason?: string; reaction: unknown; fetchedAt: string; }`
  - `cloudEnrichedKey(eventId: number): string` → `` `cloud-enriched-${eventId}` ``
  - `isPayloadComplete(payload: Pick<CloudEnrichedPayload, "actual" | "deferred" | "reaction">, releaseInstant: Date, nowMs: number): boolean`
  - `isEarningsRow(eventType: string, sourceKey: string): boolean`
  - `const COMPLETE_SETTLE_MS = 150 * 60 * 1000`, `const REACTION_READY_MS = 115 * 60 * 1000`
- Why a new module: `calendar-enrich.ts` already imports `issuerSiblings` from `fallback-earnings.ts`; Task 6 needs `fallback-earnings.ts` to consume the payload contract — importing it from `calendar-enrich.ts` would create a cycle.

- [ ] **Step 1: Write the failing test**

Create `workers/cron/test/cloud-enriched.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  cloudEnrichedKey,
  isPayloadComplete,
  isEarningsRow,
  COMPLETE_SETTLE_MS,
} from "../src/cloud-enriched";

const RELEASE = new Date("2026-07-15T20:15:00Z"); // 16:15 ET

describe("cloud-enriched contract", () => {
  it("keys payloads by event id", () => {
    expect(cloudEnrichedKey(42)).toBe("cloud-enriched-42");
  });

  it("earnings predicate mirrors the Mac rule (event_type OR finnhub source_key)", () => {
    expect(isEarningsRow("earnings", "manual:AAPL:2026-07-15:earnings")).toBe(true);
    expect(isEarningsRow("other_macro", "finnhub:AAPL:2026-07-15")).toBe(true);
    expect(isEarningsRow("cpi", "fred:10")).toBe(false);
  });

  it("incomplete: no actual", () => {
    expect(
      isPayloadComplete({ actual: null, reaction: { source: "yahoo" } }, RELEASE, RELEASE.getTime() + 60_000),
    ).toBe(false);
  });

  it("incomplete: deferred actual", () => {
    expect(
      isPayloadComplete({ actual: "EPS 1.00", deferred: true, reaction: null }, RELEASE, RELEASE.getTime() + 60_000),
    ).toBe(false);
  });

  it("complete: actual + reaction", () => {
    expect(
      isPayloadComplete({ actual: "EPS 1.00", reaction: { source: "yahoo" } }, RELEASE, RELEASE.getTime() + 60_000),
    ).toBe(true);
  });

  it("incomplete: actual only, before the 150-min settle", () => {
    expect(
      isPayloadComplete({ actual: "EPS 1.00", reaction: null }, RELEASE, RELEASE.getTime() + COMPLETE_SETTLE_MS - 1),
    ).toBe(false);
  });

  it("complete: actual only, at/after the 150-min settle (reaction window closed)", () => {
    expect(
      isPayloadComplete({ actual: "EPS 1.00", reaction: null }, RELEASE, RELEASE.getTime() + COMPLETE_SETTLE_MS),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd workers/cron && npx vitest run test/cloud-enriched.test.ts`
Expected: FAIL — cannot resolve `../src/cloud-enriched`.

- [ ] **Step 3: Create the module**

Create `workers/cron/src/cloud-enriched.ts`:

```ts
/**
 * Cloud-enrichment payload contract — the KV bridge between calendar-enrich
 * (producer, `cloud-enriched-{eventId}` keys) and fallback-earnings (consumer,
 * B8 recap road). Own module because calendar-enrich already imports
 * issuerSiblings from fallback-earnings — sharing via calendar-enrich would
 * be a circular import.
 */

import type { WorkerEnrichActualResult } from "./enrich-actuals";

export interface CloudEnrichedPayload {
  eventId: number;
  source_key: string;
  actual: string | null;
  consensus: string | null;
  source: WorkerEnrichActualResult["source"];
  deferred?: boolean;
  reason?: string;
  reaction: unknown; // ReactionSnapshot JSON, or null
  fetchedAt: string;
}

export function cloudEnrichedKey(eventId: number): string {
  return `cloud-enriched-${eventId}`;
}

/** Mac enrichment-runner REACTION_SETTLE_MS mirror — reaction window closes 150 min post-release. */
export const COMPLETE_SETTLE_MS = 150 * 60 * 1000;

/** Mac enrichment-runner REACTION_READY_MS mirror — earnings reaction attempts are pointless before T+115 (bars target T+120, 10-min tolerance). */
export const REACTION_READY_MS = 115 * 60 * 1000;

/** Earnings-row predicate — mirrors the Mac rule (source='finnhub' OR event_type='earnings'). */
export function isEarningsRow(eventType: string, sourceKey: string): boolean {
  return eventType === "earnings" || sourceKey.startsWith("finnhub:");
}

/**
 * The ONE completeness definition (Mac enrichment-runner mirror): a payload is
 * COMPLETE when it carries a non-deferred actual AND (a reaction OR the
 * release is ≥150 min old — nothing more will arrive). calendar-enrich stops
 * retrying at complete; fallback-earnings only recaps from a complete payload.
 */
export function isPayloadComplete(
  payload: Pick<CloudEnrichedPayload, "actual" | "deferred" | "reaction">,
  releaseInstant: Date,
  nowMs: number,
): boolean {
  if (payload.actual == null || payload.deferred === true) return false;
  if (payload.reaction != null) return true;
  return nowMs - releaseInstant.getTime() >= COMPLETE_SETTLE_MS;
}
```

- [ ] **Step 4: Re-wire `calendar-enrich.ts`**

In `workers/cron/src/calendar-enrich.ts`:
1. Delete the local `export function cloudEnrichedKey(...)` (near line 136) and the local `export interface CloudEnrichedPayload {...}` (near line 142).
2. Add near the top imports:

```ts
import {
  cloudEnrichedKey,
  isPayloadComplete,
  isEarningsRow,
  REACTION_READY_MS,
  type CloudEnrichedPayload,
} from "./cloud-enriched";

// Back-compat re-exports — existing importers/tests reach these through
// calendar-enrich; the definitions now live in cloud-enriched.ts.
export { cloudEnrichedKey, isPayloadComplete, type CloudEnrichedPayload };
```

(`isPayloadComplete`, `isEarningsRow`, `REACTION_READY_MS` become used in Task 5 — if the linter complains about unused imports at this task, keep only `cloudEnrichedKey` + the type and add the rest in Task 5.)
3. Run `grep -rn "CloudEnrichedPayload\|cloudEnrichedKey" workers/cron/src workers/cron/test` and update any importer that breaks (expected: none — `index.ts` uses raw string keys).

- [ ] **Step 5: Run tests + typecheck**

Run: `cd workers/cron && npx vitest run test/cloud-enriched.test.ts test/calendar-enrich.test.ts && npx tsc --noEmit`
Expected: PASS / clean.

- [ ] **Step 6: Commit**

```bash
git add workers/cron/src/cloud-enriched.ts workers/cron/src/calendar-enrich.ts workers/cron/test/cloud-enriched.test.ts
git commit -m "feat(worker): shared cloud-enriched payload contract + completeness predicate (B8)"
```

---

### Task 4: calendar-enrich gate 18:59 + per-type candidate window

**Files:**
- Modify: `workers/cron/src/calendar-enrich.ts` (`shouldRunCalendarEnrich` ~line 86; candidate loop ~lines 248-271)
- Test: `workers/cron/test/calendar-enrich.test.ts` (append)

**Interfaces:**
- Consumes: `isEarningsRow` from `./cloud-enriched` (Task 3).
- Produces: `shouldRunCalendarEnrich` honoring 09:30–18:59 ET; earnings candidates accepted up to 12h post-release (macro unchanged at 2h). Task 5 builds on the widened loop.

- [ ] **Step 1: Write the failing tests**

Append to `workers/cron/test/calendar-enrich.test.ts` (it already imports `runCloudFallback`; add `shouldRunCalendarEnrich` to that import). The file's existing helpers `makeEnv()`, `makeEnrichSnapshot()`, and mocked `loadLatestSnapshot` / `fetchActualForEventCloud` / `captureReactionFromYahoo` are reused; `composeReleaseInstant` is imported real.

```ts
describe("shouldRunCalendarEnrich gate (B8: 18:59 upper bound for AMC reactions)", () => {
  it("runs through 18:59 ET on a weekday", () => {
    expect(shouldRunCalendarEnrich({ hour: 18, minute: 30, dow: 3 })).toBe(true);
    expect(shouldRunCalendarEnrich({ hour: 18, minute: 59, dow: 3 })).toBe(true);
  });
  it("stops at 19:00 ET and stays weekday-only", () => {
    expect(shouldRunCalendarEnrich({ hour: 19, minute: 0, dow: 3 })).toBe(false);
    expect(shouldRunCalendarEnrich({ hour: 18, minute: 30, dow: 6 })).toBe(false);
  });
});

describe("per-type candidate window (B8: earnings 12h, macro 2h)", () => {
  beforeEach(() => {
    vi.mocked(loadLatestSnapshot).mockReset();
    vi.mocked(fetchActualForEventCloud).mockReset();
    vi.mocked(fetchActualForEventCloud).mockResolvedValue({
      actual: "EPS 1.60 · Rev 91,000,000,000",
      consensus: "EPS 1.50 · Rev 90,000,000,000",
      source: "finnhub",
    });
  });

  it("keeps an earnings row alive 5h post-release", async () => {
    vi.mocked(loadLatestSnapshot).mockResolvedValue(makeEnrichSnapshot());
    const release = composeReleaseInstant(EVENT_DATE, RELEASE_TIME)!;
    const res = await runCloudFallback(makeEnv(), { nowMs: release.getTime() + 5 * 3600_000, pacingMs: 0 });
    expect(res.kind).toBe("success");
    expect(res.candidatesProcessed).toBe(1);
  });

  it("drops a MACRO row 5h post-release (2h window unchanged)", async () => {
    const snap = makeEnrichSnapshot();
    const ev = snap.calendarEvents[0] as Record<string, unknown>;
    ev.event_type = "cpi";
    ev.source_key = "fred:10";
    vi.mocked(loadLatestSnapshot).mockResolvedValue(snap);
    const release = composeReleaseInstant(EVENT_DATE, RELEASE_TIME)!;
    const res = await runCloudFallback(makeEnv(), { nowMs: release.getTime() + 5 * 3600_000, pacingMs: 0 });
    expect(res.kind).toBe("no_candidates");
  });

  it("drops an earnings row past 12h", async () => {
    vi.mocked(loadLatestSnapshot).mockResolvedValue(makeEnrichSnapshot());
    const release = composeReleaseInstant(EVENT_DATE, RELEASE_TIME)!;
    const res = await runCloudFallback(makeEnv(), { nowMs: release.getTime() + 13 * 3600_000, pacingMs: 0 });
    expect(res.kind).toBe("no_candidates");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd workers/cron && npx vitest run test/calendar-enrich.test.ts`
Expected: FAIL — `shouldRunCalendarEnrich(…18:30…)` false; 5h earnings case returns `no_candidates`.

- [ ] **Step 3: Implement**

In `workers/cron/src/calendar-enrich.ts`:

(a) `shouldRunCalendarEnrich` — change the return line and the header comment:

```ts
  // Upper bound 18:59 ET (was 17:59, B8): reaction capture needs a tick at
  // ≥ release+110min (bars target T+120 with 10-min tolerance —
  // BAR_TOLERANCE_MS in reaction-matcher.ts). The AMC cohort releases
  // 16:00–16:30, so the latest capturable floor is 18:20 (16:30 release);
  // 18:59 gives every AMC name at least two tick opportunities
  // (e.g. 16:30 → 18:30 + 18:45). Before this, cloud AMC reactions were
  // structurally impossible.
  return minuteOfDay >= 9 * 60 + 30 && minuteOfDay <= 18 * 60 + 59;
```

(b) Add next to `CANDIDATE_WINDOW_MS_MAX` (~line 193):

```ts
// Earnings rows retry up to 12h post-release (Mac MAX_AGE_MS_EARNINGS mirror
// — a BMO 08:00 print can't capture a reaction before the market opens, and
// retries continue until the payload is COMPLETE). Macro rows keep 2h.
const MAX_AGE_MS_EARNINGS = 12 * 60 * 60 * 1000;
```

(c) In the candidate loop, replace the fixed-window check:

```ts
    const ageMs = nowMs - releaseInstant.getTime();
    const maxAgeMs = isEarningsRow(
      typeof ev.event_type === "string" ? ev.event_type : "",
      ev.source_key,
    )
      ? MAX_AGE_MS_EARNINGS
      : CANDIDATE_WINDOW_MS_MAX;
    if (ageMs < CANDIDATE_WINDOW_MS_MIN || ageMs > maxAgeMs) continue;
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd workers/cron && npx vitest run test/calendar-enrich.test.ts`
Expected: PASS (existing tests too — their scenarios sit inside both windows).

- [ ] **Step 5: Commit**

```bash
git add workers/cron/src/calendar-enrich.ts workers/cron/test/calendar-enrich.test.ts
git commit -m "feat(worker): enrich gate to 18:59 ET + 12h earnings candidate window (B8)"
```

---

### Task 5: calendar-enrich retry-until-complete + T+115 reaction gate + COALESCE overwrite

**Files:**
- Modify: `workers/cron/src/calendar-enrich.ts` (candidate processing loop, ~lines 279-364)
- Test: `workers/cron/test/calendar-enrich.test.ts` (append)

**Interfaces:**
- Consumes: `isPayloadComplete`, `isEarningsRow`, `REACTION_READY_MS`, `CloudEnrichedPayload` from `./cloud-enriched`.
- Produces: KV payloads that eventually become complete for earnings events — the data Task 6's recap road reads. Behavior contract: earnings payloads are overwritten each tick until complete; a captured `actual`/`consensus`/`reaction` is never erased; macro rows never re-process an existing payload; earnings reaction fetches never fire before T+115.

- [ ] **Step 1: Write the failing tests**

Append to `workers/cron/test/calendar-enrich.test.ts`. Import `captureReactionFromYahoo` at the top of the file if not present (`import { captureReactionFromYahoo } from "../src/yahoo";`) and `cloudEnrichedKey` from `../src/cloud-enriched`.

```ts
describe("retry-until-complete (B8: earnings only, Mac migration-062 mirror)", () => {
  const release = () => composeReleaseInstant(EVENT_DATE, RELEASE_TIME)!;

  beforeEach(() => {
    vi.mocked(loadLatestSnapshot).mockReset();
    vi.mocked(fetchActualForEventCloud).mockReset();
    vi.mocked(captureReactionFromYahoo).mockReset();
    vi.mocked(captureReactionFromYahoo).mockResolvedValue({ source: "yahoo" } as never);
  });

  async function seedPayload(env: ReturnType<typeof makeEnv>, payload: Record<string, unknown>) {
    await env.CRON_KV.put(cloudEnrichedKey(1), JSON.stringify(payload));
  }

  it("re-attempts an earnings payload whose actual is missing", async () => {
    vi.mocked(loadLatestSnapshot).mockResolvedValue(makeEnrichSnapshot());
    vi.mocked(fetchActualForEventCloud).mockResolvedValue({
      actual: "EPS 1.60 · Rev 91,000,000,000", consensus: "EPS 1.50 · Rev 90,000,000,000", source: "finnhub",
    });
    const env = makeEnv();
    await seedPayload(env, { eventId: 1, source_key: "finnhub:AAPL:2026-06-15", actual: null, consensus: null, source: "finnhub", reaction: null, fetchedAt: new Date(release().getTime() + 10 * 60_000).toISOString() });
    const res = await runCloudFallback(env, { nowMs: release().getTime() + 3 * 3600_000, pacingMs: 0 });
    expect(res.candidatesProcessed).toBe(1);
    expect(vi.mocked(fetchActualForEventCloud)).toHaveBeenCalledTimes(1);
    const stored = JSON.parse((await env.CRON_KV.get(cloudEnrichedKey(1)))!) as Record<string, unknown>;
    expect(stored.actual).toBe("EPS 1.60 · Rev 91,000,000,000");
  });

  it("skips an earnings payload that is already complete", async () => {
    vi.mocked(loadLatestSnapshot).mockResolvedValue(makeEnrichSnapshot());
    const env = makeEnv();
    await seedPayload(env, { eventId: 1, source_key: "finnhub:AAPL:2026-06-15", actual: "EPS 1.60", consensus: null, source: "finnhub", reaction: { source: "yahoo" }, fetchedAt: new Date().toISOString() });
    await runCloudFallback(env, { nowMs: release().getTime() + 3 * 3600_000, pacingMs: 0 });
    expect(vi.mocked(fetchActualForEventCloud)).not.toHaveBeenCalled();
    expect(vi.mocked(captureReactionFromYahoo)).not.toHaveBeenCalled();
  });

  it("keeps MACRO single-shot: existing payload → untouched even if incomplete", async () => {
    const snap = makeEnrichSnapshot();
    const ev = snap.calendarEvents[0] as Record<string, unknown>;
    ev.event_type = "cpi";
    ev.source_key = "fred:10";
    vi.mocked(loadLatestSnapshot).mockResolvedValue(snap);
    const env = makeEnv();
    await seedPayload(env, { eventId: 1, source_key: "fred:10", actual: null, consensus: null, source: "fred", reaction: null, fetchedAt: new Date().toISOString() });
    await runCloudFallback(env, { nowMs: release().getTime() + 60 * 60_000, pacingMs: 0 });
    expect(vi.mocked(fetchActualForEventCloud)).not.toHaveBeenCalled();
  });

  it("does not fetch Yahoo for an earnings row before T+115 (actual-only tick)", async () => {
    vi.mocked(loadLatestSnapshot).mockResolvedValue(makeEnrichSnapshot());
    vi.mocked(fetchActualForEventCloud).mockResolvedValue({ actual: "EPS 1.60", consensus: null, source: "finnhub" });
    const env = makeEnv();
    await runCloudFallback(env, { nowMs: release().getTime() + 30 * 60_000, pacingMs: 0 });
    expect(vi.mocked(captureReactionFromYahoo)).not.toHaveBeenCalled();
    const stored = JSON.parse((await env.CRON_KV.get(cloudEnrichedKey(1)))!) as Record<string, unknown>;
    expect(stored.actual).toBe("EPS 1.60");
    expect(stored.reaction).toBeNull();
  });

  it("still fetches Yahoo immediately for a macro row (never gated)", async () => {
    const snap = makeEnrichSnapshot();
    const ev = snap.calendarEvents[0] as Record<string, unknown>;
    ev.event_type = "cpi";
    ev.source_key = "fred:10";
    vi.mocked(loadLatestSnapshot).mockResolvedValue(snap);
    vi.mocked(fetchActualForEventCloud).mockResolvedValue({ actual: "3.2%", consensus: null, source: "fred" });
    const env = makeEnv();
    await runCloudFallback(env, { nowMs: release().getTime() + 30 * 60_000, pacingMs: 0 });
    expect(vi.mocked(captureReactionFromYahoo)).toHaveBeenCalledTimes(1);
  });

  it("COALESCEs on overwrite: a captured actual survives a null re-fetch", async () => {
    vi.mocked(loadLatestSnapshot).mockResolvedValue(makeEnrichSnapshot());
    vi.mocked(fetchActualForEventCloud).mockResolvedValue({ actual: null, consensus: null, source: "finnhub", reason: "no_actual_yet" });
    const env = makeEnv();
    // actual present but reaction missing and settle not reached → incomplete → retried
    await seedPayload(env, { eventId: 1, source_key: "finnhub:AAPL:2026-06-15", actual: "EPS 1.60", consensus: "EPS 1.50", source: "finnhub", reaction: null, fetchedAt: new Date().toISOString() });
    vi.mocked(captureReactionFromYahoo).mockResolvedValue(null as never);
    await runCloudFallback(env, { nowMs: release().getTime() + 2 * 3600_000, pacingMs: 0 });
    const stored = JSON.parse((await env.CRON_KV.get(cloudEnrichedKey(1)))!) as Record<string, unknown>;
    expect(stored.actual).toBe("EPS 1.60"); // not erased
    expect(stored.consensus).toBe("EPS 1.50");
    // existing actual present → Finnhub fetch skipped (fetch-only-what's-missing)
    expect(vi.mocked(fetchActualForEventCloud)).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd workers/cron && npx vitest run test/calendar-enrich.test.ts`
Expected: FAIL — "re-attempts" case processes 0 candidates (skip-if-existing), T+115 case calls Yahoo, etc.

- [ ] **Step 3: Implement**

In `runCloudFallback`'s per-candidate loop, replace the two lines

```ts
      const existing = await env.CRON_KV.get(cloudEnrichedKey(cand.id));
      if (existing) continue; // idempotent across ticks in the same slot
```

with:

```ts
      const isEarnings = isEarningsRow(cand.event_type, cand.source_key);
      const existingRaw = await env.CRON_KV.get(cloudEnrichedKey(cand.id));
      let existing: CloudEnrichedPayload | null = null;
      if (existingRaw) {
        try {
          existing = JSON.parse(existingRaw) as CloudEnrichedPayload;
        } catch {
          existing = null;
        }
        // Macro rows keep single-shot semantics EXACTLY (immediate partial
        // capture is by design). Earnings rows retry until COMPLETE — the
        // Worker mirror of the Mac's migration-062 retry-until-complete.
        if (!isEarnings) continue;
        if (existing && isPayloadComplete(existing, cand.releaseInstant, nowMs)) continue;
      }
```

Then replace the actual-fetch + reaction block (from `const actual = await fetchActualForEventCloud(` through the `const payload: CloudEnrichedPayload = {...}` literal) with:

```ts
      // Fetch only what's missing — an existing actual is never re-fetched
      // (subrequest saving) and never erased by a later null fetch.
      const haveActual = existing?.actual != null && existing?.deferred !== true;
      const actual: WorkerEnrichActualResult = haveActual
        ? { actual: existing!.actual, consensus: existing!.consensus, source: existing!.source }
        : await fetchActualForEventCloud(
            { source_key: cand.source_key, event_date: cand.event_date, consensus_estimate: cand.consensus_estimate },
            env,
          );
      if (!haveActual && actual.deferred) deferred += 1;

      const sectorEtf = resolveSectorEtf(cand.event_type, null);
      // Earnings reactions are pointless before T+115 (bars target T+120,
      // 10-min tolerance) — Mac REACTION_READY_MS mirror. Macro rows are
      // NEVER gated (immediate partial capture is by design).
      const reactionAllowed =
        !isEarnings || nowMs - cand.releaseInstant.getTime() >= REACTION_READY_MS;
      const reaction =
        existing?.reaction ??
        (reactionAllowed
          ? await captureReactionFromYahoo(cand.releaseInstant, sectorEtf, {
              pacingMs,
              eventSymbol: cand.event_type === "earnings" ? cand.symbol : null,
            })
          : null);

      const payload: CloudEnrichedPayload = {
        eventId: cand.id,
        source_key: cand.source_key,
        actual: actual.actual ?? existing?.actual ?? null,
        consensus: actual.consensus ?? existing?.consensus ?? null,
        source: actual.actual != null ? actual.source : existing?.source ?? actual.source,
        deferred: actual.deferred,
        reason: actual.reason,
        reaction: reaction ?? existing?.reaction ?? null,
        fetchedAt: new Date().toISOString(),
      };
```

(The subsequent `env.CRON_KV.put(...)` and the push-at-print block stay as they are — the push is already deduped on `print-push-{eventId}`, so retry ticks can't re-push.) Add `WorkerEnrichActualResult` to the existing type-import from `./enrich-actuals`.

- [ ] **Step 4: Run the full Worker suite**

Run: `cd workers/cron && npx vitest run`
Expected: PASS. If an existing calendar-enrich test seeded a payload and relied on skip-if-existing for an earnings row, update it to expect retry (check each failure against the new contract before touching it).

- [ ] **Step 5: Commit**

```bash
git add workers/cron/src/calendar-enrich.ts workers/cron/test/calendar-enrich.test.ts
git commit -m "feat(worker): earnings retry-until-complete + T+115 reaction gate + COALESCE overwrite (B8)"
```

---

### Task 6: fallback-earnings — KV recap road + scan-skip reporting

**Files:**
- Modify: `workers/cron/src/fallback-earnings.ts` (`findCandidatesFromSnapshot` ~lines 258-322, `runEarningsFallback` call site ~line 180, `SnapshotCandidate` ~line 151)
- Test: `workers/cron/test/fallback-earnings.test.ts` (append)

**Interfaces:**
- Consumes: `cloudEnrichedKey`, `isPayloadComplete`, `CloudEnrichedPayload` from `./cloud-enriched` (Task 3).
- Produces (Task 7 relies on):
  - `SnapshotCandidate` gains `payload?: CloudEnrichedPayload | null`.
  - `findCandidatesFromSnapshot(snapshot: Snapshot, now: Date, kv: KVNamespace): Promise<{ candidates: SnapshotCandidate[]; skips: ScanSkip[] }>` where `interface ScanSkip { eventId: number; symbol: string; phase: EarningsPhase; reason: string }`.
  - Skip reasons produced here: `"payload-missing" | "payload-incomplete" | "kv-error"` (Task 7 adds `"no-actual" | "implausible-no-data-point"`).

- [ ] **Step 1: Write the failing tests**

Append to `workers/cron/test/fallback-earnings.test.ts` (reuses its `makeEnv`, `makeEarningsSnapshot`, mocked `loadLatestSnapshot`/`sendEmail`, real `composeReleaseInstant`; `fetchLiveIbkrPositionsCached` mock resolves `[]` in `beforeEach` — follow the file's existing pattern). Import `cloudEnrichedKey` from `../src/cloud-enriched`.

The snapshot builder's event has `release_time: "16:00"` and no `enriched_at` — exactly the same-day-AMC shape. `now` is passed via `runEarningsFallback(env, { now })`.

```ts
describe("KV recap road (B8: same-day cloud-enriched payloads)", () => {
  const release = () => composeReleaseInstant(EVENT_DATE, RELEASE_TIME)!;
  const completePayload = () => ({
    eventId: 1,
    source_key: "finnhub:AAPL:2026-06-15",
    actual: "EPS 1.60 · Rev 91,000,000,000",
    consensus: "EPS 1.50 · Rev 90,000,000,000",
    source: "finnhub",
    reaction: { source: "yahoo", window_min: 120, symbol: { symbol: "AAPL", delta_pct: 4.1 }, spy: { delta_pct: 0.3 }, qqq: { delta_pct: 0.5 } },
    fetchedAt: new Date(release().getTime() + 125 * 60_000).toISOString(),
  });

  beforeEach(() => {
    vi.mocked(loadLatestSnapshot).mockReset();
    vi.mocked(sendEmail).mockClear();
    vi.mocked(fetchLiveIbkrPositionsCached).mockResolvedValue([]);
  });

  it("sends a recap from a complete payload and writes the cloud marker", async () => {
    vi.mocked(loadLatestSnapshot).mockResolvedValue(makeEarningsSnapshot());
    const env = makeEnv();
    await env.CRON_KV.put(cloudEnrichedKey(1), JSON.stringify(completePayload()));
    const now = new Date(release().getTime() + 150 * 60_000); // fetchedAt + 25min
    const res = await runEarningsFallback(env, { now });
    expect(res.sent).toBe(1);
    expect(res.details[0]).toMatchObject({ eventId: 1, phase: "recap", status: "sent" });
    expect(await env.CRON_KV.get("cloud-sent-earnings-recap-1")).not.toBeNull();
  });

  it("skips an incomplete payload with reason, no marker, no email", async () => {
    vi.mocked(loadLatestSnapshot).mockResolvedValue(makeEarningsSnapshot());
    const env = makeEnv();
    const p = completePayload();
    (p as Record<string, unknown>).actual = null;
    await env.CRON_KV.put(cloudEnrichedKey(1), JSON.stringify(p));
    const now = new Date(release().getTime() + 150 * 60_000);
    const res = await runEarningsFallback(env, { now });
    expect(res.sent).toBe(0);
    expect(vi.mocked(sendEmail)).not.toHaveBeenCalled();
    expect(await env.CRON_KV.get("cloud-sent-earnings-recap-1")).toBeNull();
    expect(res.details).toContainEqual(
      expect.objectContaining({ eventId: 1, phase: "recap", status: "skipped", reason: "payload-incomplete" }),
    );
  });

  it("reports payload-missing when nothing is in KV yet", async () => {
    vi.mocked(loadLatestSnapshot).mockResolvedValue(makeEarningsSnapshot());
    const env = makeEnv();
    const now = new Date(release().getTime() + 60 * 60_000);
    const res = await runEarningsFallback(env, { now });
    expect(res.details).toContainEqual(
      expect.objectContaining({ eventId: 1, phase: "recap", status: "skipped", reason: "payload-missing" }),
    );
  });

  it("degrades a KV read failure to a markerless skip and keeps running", async () => {
    vi.mocked(loadLatestSnapshot).mockResolvedValue(makeEarningsSnapshot());
    const env = makeEnv();
    (env.CRON_KV.get as ReturnType<typeof vi.fn>).mockImplementation(async (key: string) => {
      if (key.startsWith("cloud-enriched-")) throw new Error("kv down");
      return null;
    });
    const now = new Date(release().getTime() + 60 * 60_000);
    const res = await runEarningsFallback(env, { now });
    expect(res.failed).toBe(0);
    expect(res.details).toContainEqual(
      expect.objectContaining({ eventId: 1, phase: "recap", status: "skipped", reason: "kv-error" }),
    );
  });

  it("does not recap an expired payload (fetchedAt older than 4h)", async () => {
    vi.mocked(loadLatestSnapshot).mockResolvedValue(makeEarningsSnapshot());
    const env = makeEnv();
    await env.CRON_KV.put(cloudEnrichedKey(1), JSON.stringify(completePayload()));
    const now = new Date(release().getTime() + 125 * 60_000 + 4 * 3600_000 + 60_000);
    const res = await runEarningsFallback(env, { now });
    expect(res.sent).toBe(0);
    expect(vi.mocked(sendEmail)).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd workers/cron && npx vitest run test/fallback-earnings.test.ts`
Expected: FAIL — no KV road exists; sent stays 0 / details lack scan skips.

- [ ] **Step 3: Implement**

In `workers/cron/src/fallback-earnings.ts`:

(a) Imports:

```ts
import {
  cloudEnrichedKey,
  isPayloadComplete,
  type CloudEnrichedPayload,
} from "./cloud-enriched";
```

(b) Types (next to `SnapshotCandidate`):

```ts
interface SnapshotCandidate {
  eventId: number;
  symbol: string;
  phase: EarningsPhase;
  event: CalendarEventRow;
  /** Present on KV-road recap candidates — carries same-day cloud-enriched data. */
  payload?: CloudEnrichedPayload | null;
}

interface ScanSkip {
  eventId: number;
  symbol: string;
  phase: EarningsPhase;
  reason: string;
}

// KV probe band: release within the last 12h (enrich retry window) + 4h
// (recap window). Outside it a payload can't produce an unexpired recap.
const KV_PROBE_WINDOW_MS = 16 * 60 * 60 * 1000;
```

(c) `findCandidatesFromSnapshot` becomes async, takes `kv`, returns `{ candidates, skips }`. Full replacement of the recap block inside the event loop (the preview block is untouched):

```ts
async function findCandidatesFromSnapshot(
  snapshot: Snapshot,
  now: Date,
  kv: KVNamespace,
): Promise<{ candidates: SnapshotCandidate[]; skips: ScanSkip[] }> {
  // …existing setup (heldSet/watchSet/muted/auditedSet) unchanged…
  const out: SnapshotCandidate[] = [];
  const skips: ScanSkip[] = [];

  for (const e of snapshot.calendarEvents) {
    // …existing family/mute/preview logic unchanged…

    // Recap — road 1 (snapshot enriched_at, pre-2am enrichment) stays as-is
    // here; Task 7 adds the no-actual gate to it.
    const enrichedAt = (e as Record<string, unknown>).enriched_at as string | null | undefined;
    const recapAudited = auditedSet.has(auditKey(e.id, "recap"));
    if (enrichedAt && !recapAudited) {
      const enrichedMs = Date.parse(enrichedAt.replace(" ", "T") + "Z");
      if (Number.isFinite(enrichedMs)) {
        const ageMs = nowMs - enrichedMs;
        if (ageMs >= 0 && ageMs <= RECAP_WINDOW_MAX_MS) {
          out.push({ eventId: e.id, symbol: sym, phase: "recap", event: e });
        }
      }
    } else if (!enrichedAt && !recapAudited && e.release_time) {
      // Recap — road 2 (B8): same-day cloud-enriched KV payload, invisible to
      // the 2am snapshot. Probe KV only inside the release band (bounded reads).
      const releaseInstant = composeReleaseInstant(e.event_date, e.release_time as string);
      if (releaseInstant) {
        const sinceRelease = nowMs - releaseInstant.getTime();
        if (sinceRelease >= 0 && sinceRelease <= KV_PROBE_WINDOW_MS) {
          try {
            const raw = await kv.get(cloudEnrichedKey(e.id));
            if (!raw) {
              skips.push({ eventId: e.id, symbol: sym, phase: "recap", reason: "payload-missing" });
            } else {
              const payload = JSON.parse(raw) as CloudEnrichedPayload;
              if (!isPayloadComplete(payload, releaseInstant, nowMs)) {
                skips.push({ eventId: e.id, symbol: sym, phase: "recap", reason: "payload-incomplete" });
              } else {
                const readyMs = Date.parse(payload.fetchedAt);
                if (Number.isFinite(readyMs) && nowMs - readyMs >= 0 && nowMs - readyMs <= RECAP_WINDOW_MAX_MS) {
                  out.push({ eventId: e.id, symbol: sym, phase: "recap", event: e, payload });
                }
                // fetchedAt outside the 4h window → expired recap, silent
                // (mirrors the snapshot road's silent expiry).
              }
            }
          } catch (err) {
            console.warn(`[fallback-earnings] KV probe failed for event ${e.id}:`, err);
            skips.push({ eventId: e.id, symbol: sym, phase: "recap", reason: "kv-error" });
          }
        }
      }
    }
  }

  return { candidates: out, skips };
}
```

(d) Call site in `runEarningsFallback` (replace `const candidates = findCandidatesFromSnapshot(snapshot, now);`):

```ts
  const scan = await findCandidatesFromSnapshot(snapshot, now, env.CRON_KV);
  const candidates = scan.candidates;
  result.swept = candidates.length;
  for (const s of scan.skips) {
    result.skipped++;
    result.details.push({ eventId: s.eventId, symbol: s.symbol, phase: s.phase, status: "skipped", reason: s.reason });
  }
  if (candidates.length === 0) return result;
```

- [ ] **Step 4: Run to verify they pass; fix existing fixtures**

Run: `cd workers/cron && npx vitest run test/fallback-earnings.test.ts`
Expected: new tests PASS. Existing tests may now see extra `skipped` details for recap-band events (e.g. a preview-window fixture whose release is also inside the probe band cannot be — preview is pre-release, `sinceRelease < 0`, so no probe). If any existing assertion counts details/skipped strictly, loosen it to the specific detail it asserts (check each against the new contract).

- [ ] **Step 5: Commit**

```bash
git add workers/cron/src/fallback-earnings.ts workers/cron/test/fallback-earnings.test.ts
git commit -m "feat(worker): same-day KV recap road + scan-skip observability (B8)"
```

---

### Task 7: fallback-earnings — safety gates (actual-required, precedence, plausibility, real-data-point rule)

**Files:**
- Modify: `workers/cron/src/fallback-earnings.ts` (`renderScoreboard` ~line 451, `composeAndSend` ~line 324, `runEarningsFallback` loop ~line 206, road-1 candidacy from Task 6)
- Test: `workers/cron/test/fallback-earnings.test.ts` (append)

**Interfaces:**
- Consumes: `isPlausibleEarnings` from `./plausibility` (Task 2); `CloudEnrichedPayload` (Task 3); `SnapshotCandidate.payload` (Task 6).
- Produces:
  - `evaluateRecapContent(event: CalendarEventRow, payload: CloudEnrichedPayload | null): { send: true; implausible: boolean } | { send: false; reason: "no-actual" | "implausible-no-data-point" }` (exported).
  - `renderScoreboard(event: CalendarEventRow, phase: EarningsPhase, payload: CloudEnrichedPayload | null, implausible: boolean): string` (exported — replaces the unused `_snapshot`/`_family` params).

- [ ] **Step 1: Write the failing tests**

Append to `workers/cron/test/fallback-earnings.test.ts`. Import `renderScoreboard, evaluateRecapContent` from `../src/fallback-earnings`.

```ts
describe("recap safety gates (B8)", () => {
  const baseEvent = () =>
    ({
      id: 1, source: "finnhub", event_type: "earnings", event_date: EVENT_DATE,
      event_time: "AMC", title: "AAPL earnings", description: null, security_id: null,
      symbol: "AAPL", expected_impact: "high",
      consensus_estimate: "EPS 1.50 · Rev 90,000,000,000",
      previous_value: null, raw_json: null,
      consensus_value: null, actual_value: null, reaction_snapshot: null,
    }) as unknown as import("../src/state").CalendarEventRow;

  it("no actual anywhere → send:false no-actual", () => {
    expect(evaluateRecapContent(baseEvent(), null)).toEqual({ send: false, reason: "no-actual" });
  });

  it("payload actual counts as the actual", () => {
    const v = evaluateRecapContent(baseEvent(), {
      eventId: 1, source_key: "finnhub:AAPL:2026-06-15",
      actual: "EPS 1.60 · Rev 91,000,000,000", consensus: null, source: "finnhub",
      reaction: null, fetchedAt: new Date().toISOString(),
    });
    expect(v).toEqual({ send: true, implausible: false });
  });

  it("implausible actual + no reaction → send:false implausible-no-data-point", () => {
    const ev = baseEvent();
    (ev as Record<string, unknown>).actual_value = "EPS 5.11"; // vs cons 1.50 → ratio 3.4
    expect(evaluateRecapContent(ev, null)).toEqual({ send: false, reason: "implausible-no-data-point" });
  });

  it("implausible actual + reaction present → sends, flagged implausible", () => {
    const ev = baseEvent();
    (ev as Record<string, unknown>).actual_value = "EPS 5.11";
    (ev as Record<string, unknown>).reaction_snapshot = JSON.stringify({ symbol: { delta_pct: -4.2 } });
    expect(evaluateRecapContent(ev, null)).toEqual({ send: true, implausible: true });
  });

  it("scoreboard NEVER renders consensus_value in the Actual column", () => {
    const ev = baseEvent();
    (ev as Record<string, unknown>).consensus_value = "EPS 1.55 · Rev 90,500,000,000";
    const md = renderScoreboard(ev, "recap", null, false);
    const epsRow = md.split("\n").find((l) => l.includes("**EPS**"))!;
    expect(epsRow).toContain("| — |"); // Actual cell blank — 1.55 must not appear as actual
  });

  it("scoreboard consensus precedence: consensus_value > payload.consensus > consensus_estimate", () => {
    const ev = baseEvent();
    (ev as Record<string, unknown>).consensus_value = "EPS 1.55 · Rev 90,500,000,000";
    const md = renderScoreboard(ev, "recap", null, false);
    expect(md).toContain("1.55");
    const md2 = renderScoreboard(baseEvent(), "recap", {
      eventId: 1, source_key: "x", actual: null, consensus: "EPS 1.52 · Rev 90,200,000,000",
      source: "finnhub", reaction: null, fetchedAt: new Date().toISOString(),
    }, false);
    expect(md2).toContain("1.52");
    expect(renderScoreboard(baseEvent(), "recap", null, false)).toContain("1.50");
  });

  it("scoreboard blanks implausible actuals and appends the ⚠ line", () => {
    const ev = baseEvent();
    (ev as Record<string, unknown>).actual_value = "EPS 5.11 · Rev 91,000,000,000";
    (ev as Record<string, unknown>).reaction_snapshot = JSON.stringify({ symbol: { delta_pct: -4.2 } });
    const md = renderScoreboard(ev, "recap", null, true);
    expect(md).not.toContain("5.11");
    expect(md).toContain("⚠ Reported actuals were flagged as implausible");
    expect(md).toContain("-4.20%"); // reaction row still renders
  });

  it("scoreboard renders the payload reaction when the snapshot has none", () => {
    const ev = baseEvent();
    (ev as Record<string, unknown>).actual_value = "EPS 1.60 · Rev 91,000,000,000";
    const md = renderScoreboard(ev, "recap", {
      eventId: 1, source_key: "x", actual: null, consensus: null, source: "finnhub",
      reaction: { symbol: { delta_pct: 3.15 }, spy: { delta_pct: 0.4 } },
      fetchedAt: new Date().toISOString(),
    }, false);
    expect(md).toContain("+3.15%");
  });

  it("end-to-end: snapshot-road recap with enriched_at but NULL actual is skipped markerless", async () => {
    const snap = makeEarningsSnapshot();
    const ev = snap.calendarEvents[0] as Record<string, unknown>;
    const release = composeReleaseInstant(EVENT_DATE, RELEASE_TIME)!;
    ev.enriched_at = new Date(release.getTime() + 130 * 60_000).toISOString().replace("T", " ").slice(0, 19);
    ev.actual_value = null;
    vi.mocked(loadLatestSnapshot).mockResolvedValue(snap as never);
    const env = makeEnv();
    const res = await runEarningsFallback(env, { now: new Date(release.getTime() + 150 * 60_000) });
    expect(res.sent).toBe(0);
    expect(vi.mocked(sendEmail)).not.toHaveBeenCalled();
    expect(await env.CRON_KV.get("cloud-sent-earnings-recap-1")).toBeNull();
    expect(res.details).toContainEqual(
      expect.objectContaining({ eventId: 1, phase: "recap", status: "skipped", reason: "no-actual" }),
    );
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd workers/cron && npx vitest run test/fallback-earnings.test.ts`
Expected: FAIL — `evaluateRecapContent` not exported; `renderScoreboard` has the old 4-arg `(event, phase, snapshot, family)` shape and renders `consensus_value` as actual.

- [ ] **Step 3: Implement**

In `workers/cron/src/fallback-earnings.ts`:

(a) Import the guard:

```ts
import { isPlausibleEarnings } from "./plausibility";
```

(b) New exported evaluator (place above `renderScoreboard`; it reuses the module's existing `parseFinnhubFigure`):

```ts
/**
 * B8 recap send-decision: (1) actual-required — no actual anywhere means no
 * candidate, never a marker; (2) "at least one real data point" — an
 * implausible actual (isPlausibleEarnings mirror, incl. B19 sign-flip) gets
 * its cells blanked, and if there's no reaction either, the email would be
 * content-free, so skip WITHOUT a marker (stricter than the Mac, which always
 * sends once complete — rationale in the 2026-07-07 B8 spec).
 */
export function evaluateRecapContent(
  event: CalendarEventRow,
  payload: CloudEnrichedPayload | null,
): { send: true; implausible: boolean } | { send: false; reason: "no-actual" | "implausible-no-data-point" } {
  const actualRaw = ((event.actual_value as string | null) ?? payload?.actual) ?? null;
  if (actualRaw == null) return { send: false, reason: "no-actual" };

  const consRaw =
    ((event.consensus_value as string | null) ?? payload?.consensus ?? event.consensus_estimate) ?? null;
  const cons = parseFinnhubFigure(consRaw);
  const act = parseFinnhubFigure(actualRaw);
  const plausible = isPlausibleEarnings(
    cons.eps != null ? Number(cons.eps) : null,
    act.eps != null ? Number(act.eps) : null,
    cons.revenue != null ? Number(cons.revenue) : null,
    act.revenue != null ? Number(act.revenue) : null,
  );

  const hasReaction =
    (event.reaction_snapshot as string | null) != null || payload?.reaction != null;
  if (!plausible && !hasReaction) return { send: false, reason: "implausible-no-data-point" };
  return { send: true, implausible: !plausible };
}
```

(c) `renderScoreboard` — new signature and data plumbing (delta/reaction/format helpers below it are unchanged):

```ts
export function renderScoreboard(
  event: CalendarEventRow,
  phase: EarningsPhase,
  payload: CloudEnrichedPayload | null,
  implausible: boolean,
): string {
  // Consensus precedence mirrors the Mac renderHeadlineTable: the
  // enrichment-time consensus_value wins, then the same-day payload's,
  // then the Finnhub-sync-time consensus_estimate.
  const cons = parseFinnhubFigure(
    (((event.consensus_value as string | null) ?? payload?.consensus ?? event.consensus_estimate) ?? null),
  );
  // Actual NEVER falls back to consensus_value — that was the
  // estimates-dressed-as-actuals failure 921d552 eliminated on the Mac.
  // Implausible actuals render blanked (⚠ line below the table).
  const actualRaw =
    phase === "recap" ? (((event.actual_value as string | null) ?? payload?.actual) ?? null) : null;
  const actual =
    phase === "recap" && !implausible
      ? parseFinnhubFigure(actualRaw)
      : { eps: null as string | null, revenue: null as string | null };
  …
  const reactionJson =
    ((event.reaction_snapshot as string | null) ??
      (payload?.reaction != null ? JSON.stringify(payload.reaction) : null));
  …
}
```

Everything from `const epsConsensus = …` down is unchanged except: the old `const reactionJson = (event.reaction_snapshot ?? null) as string | null;` line is replaced by the version above, and the trailing italic footnote line gains the warning:

```ts
  const warn = implausible
    ? `\n\n*⚠ Reported actuals were flagged as implausible vs consensus — cells blanked (B19-style basis mismatch or scrape failure). Override via POST /api/earnings/actuals once the Mac is back.*`
    : "";
  return `## ${sym} scoreboard — ${phaseLabel}\n\n…existing table…\n\n*Cloud-fallback delivery — …existing footnote…*${warn}`;
```

(d) `composeAndSend` — thread the new data: signature gains `implausible: boolean` as the last param; the `renderScoreboard` call becomes `renderScoreboard(cand.event, cand.phase, cand.payload ?? null, implausible)`.

(e) `runEarningsFallback` loop — after the marker check, before the dry-run branch:

```ts
    let implausible = false;
    if (cand.phase === "recap") {
      const verdict = evaluateRecapContent(cand.event, cand.payload ?? null);
      if (!verdict.send) {
        result.skipped++;
        result.details.push({
          eventId: cand.eventId, symbol: cand.symbol, phase: cand.phase,
          status: "skipped", reason: verdict.reason,
        });
        continue;
      }
      implausible = verdict.implausible;
    }
```

and pass `implausible` into `composeAndSend(env, snapshot, cand, liveIbkr, ibkrAccountName, implausible)`.

(f) Road-1 candidacy no-actual gate (Task 6 left it for here) — in `findCandidatesFromSnapshot`'s road-1 block, replace the plain `out.push(...)` with:

```ts
        if (((e as Record<string, unknown>).actual_value ?? null) == null) {
          skips.push({ eventId: e.id, symbol: sym, phase: "recap", reason: "no-actual" });
        } else {
          out.push({ eventId: e.id, symbol: sym, phase: "recap", event: e });
        }
```

(Note: `evaluateRecapContent` still re-checks no-actual at send time — belt-and-suspenders for the KV road, whose completeness already guarantees an actual.)

- [ ] **Step 4: Run the full Worker suite; fix existing recap fixtures**

Run: `cd workers/cron && npx vitest run`
Expected: new tests PASS. Existing recap tests whose fixture events have `enriched_at` set but `actual_value: null` will now skip — set `actual_value: "EPS 1.60 · Rev 91,000,000,000"` on those fixtures (they were modeling the exact unsafe behavior this task removes). Verify each fixture change against the new contract before making it.

- [ ] **Step 5: Typecheck**

Run: `cd workers/cron && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add workers/cron/src/fallback-earnings.ts workers/cron/test/fallback-earnings.test.ts
git commit -m "feat(worker): recap safety gates — actual-required, consensus precedence, plausibility + real-data-point rule (B8)"
```

---

### Task 8: Full suites, deploy, docs close-out

**Files:**
- Modify: `workers/cron/wrangler.toml` (comment only), `CLAUDE.md` (2 lines), `docs/plans/TODO.md` (close-out entry)

**Interfaces:**
- Consumes: everything above.
- Produces: deployed Worker + reconciled docs.

- [ ] **Step 1: Run both full suites + typechecks**

```bash
npx vitest run                      # Mac suite (repo root) — expect ~3168+, all pass
cd workers/cron && npx vitest run   # Worker suite — expect ~289+, all pass
npx tsc --noEmit                    # repo root
cd workers/cron && npx tsc --noEmit
```
Expected: all green. Report counts.

- [ ] **Step 2: Update the stale gate comments**

In `workers/cron/wrangler.toml`, the triggers comment line `+ earnings-fallback (self-gates 05:00-20:00 ET)` block: change `calendar-enrich (self-gates 09:30-18:00 ET)` to `09:30-18:59 ET`. In `workers/cron/src/calendar-enrich.ts`, the file-header comment ("self-gates … 09:30 → 18:00 ET") likewise → `18:59`.

- [ ] **Step 3: Deploy the Worker (ASK THE USER FIRST)**

Ask the user to confirm, then:

```bash
cd workers/cron && npx wrangler deploy
```
Expected: new version id printed. Then verify end-to-end wiring with a dry-run: `curl -s -H "X-Cron-Secret: $CRON_SHARED_SECRET" "https://vanguard-skin-cron.isaac-3d1.workers.dev/internal/trigger?job=earnings&dryRun=true"` (check the exact internal-trigger route shape in `workers/cron/src/index.ts` before calling — adjust the query params to what the route actually accepts; expect JSON with `swept`/`details`, and confirm no error mentioning `CLOUD_ENRICH_ENABLED`).

- [ ] **Step 4: Docs close-out**

- `docs/plans/TODO.md`: add a ✅ close-out line for B8 under the Earnings section (pattern: existing ✅ entries), noting: KV recap road, retry-until-complete mirror, T+115 gate, 18:59 enrich gate, safety gates, stricter real-data-point rule, plausibility parity mirror.
- `CLAUDE.md`: (1) in the earnings-digest section, update "remaining open: B8 cloud-recap parity, B15–B20, cockpit + intelligence tier" → "remaining open: cockpit + intelligence tier (B8 closed 2026-07-07; B15–B20 closed 2026-07-06)". (2) In the Phase 9b cloud-fallback sentence, note earnings payloads are retry-until-complete with a T+115 reaction gate and that the Worker enrich gate is 09:30–18:59 ET.

- [ ] **Step 5: Commit**

```bash
git add workers/cron/wrangler.toml CLAUDE.md docs/plans/TODO.md workers/cron/src/calendar-enrich.ts
git commit -m "docs: B8 close-out — gate comments, CLAUDE.md, TODO entry"
```
