# Mac-first send race — keeping the enriched email from losing to the cloud

**Date:** 2026-08-09
**Status:** Approved, pending implementation
**Scope:** weekly briefing, morning digest, evening recap (`/api/cron/{briefing,digest,evening}`)

## Problem

When the Mac is awake and running its full send pipeline, the Cloudflare Worker's
cloud fallback can still fire and deliver a degraded copy first. The Mac then
finishes and delivers its own, richer copy — the reader gets two emails with
byte-identical subject lines, and the better one arrives second.

Observed live on 2026-08-09 (Sunday briefing). All times ET:

| Time | Event |
|---|---|
| 16:34:42 | launchd tick fires inside the 16:30–16:40 ET gate; route entry |
| 16:34:42 | `await checkCloudMarker("briefing")` succeeds (no warning logged) |
| 16:34:42 | `void setRunningMarker("briefing")` issued, **not awaited** |
| 16:34:42 | Pipeline enters `syncPortfolio` → auto-refresh runs **215.6s** |
| ~16:41:26 | `[running-marker] worker unreachable for set` — the 3s AbortController fired during the block; **marker never written** |
| 16:45:00 | Worker's briefing dispatch reads markers: no `mac-sent`, no `cloud-sent`, no `mac-running` → fires fallback |
| 16:47:05 | Cloud briefing delivered; `cloud-sent-briefing-2026-08-09` written |
| 16:49:27 | Mac still working: self-admission detected on first draft, regenerating |
| 16:49:42 | Mac's launchd curl abandons at 900s (correctly does not retry — exit 28 is non-retryable) |
| 16:51:19 | Mac delivers its full briefing; `calendar_briefings` row written |

## Root cause

Two independent defects. Either one alone is sufficient to lose the race.

### Defect 1 — the aliveness signal is never written under load

`app/api/cron/briefing/route.ts` calls `void setRunningMarker("briefing")` and
immediately proceeds into the pipeline. `better-sqlite3` is synchronous, so
auto-refresh occupies the event loop continuously for minutes. The in-flight
`fetch` gets no turn, and its own 3s `AbortController` timer fires the moment the
loop frees — surfacing as a misleading "worker unreachable" warning ~7 minutes
after the call site.

The network was never the problem. `checkCloudMarker` — awaited, one line earlier,
against the same Worker — succeeded on the same tick. The defect is the `void`.

### Defect 2 — the TTL is shorter than the gap to the Worker's dispatch

`RUNNING_TTL_SECONDS` in `workers/cron/src/dedup.ts` is 10 minutes, sized in
2026-04-27 against a documented "5-min Mac pipeline plus a safety margin". The
pipeline has since grown to 13–17 minutes (4-week calendar sync, 20 narrative
pre-generations, regression backfill, self-admission regeneration). The constant
never moved with it.

Even a perfectly written marker expires before the Worker looks:

| Job | Mac tick | Marker expires | Worker fires | Covered? |
|---|---|---|---|---|
| Briefing | 16:30–16:40 | +10 min → 16:40–16:50 | 16:45 | only if tick ≥ 16:35 |
| Digest | 8:45 | 8:55 | 9:00 | never |
| Evening Mon–Thu | 19:00 | 19:10 | 19:15 | never |
| Evening Fri | 17:30 | 17:40 | 17:45 | never |

### Why this looked healthy

A Mac that finishes fast writes `mac-sent` via `confirmMacSent`, and the Worker
skips on that instead. The 2026-08-02 briefing finished at 16:43:06 — 1m54s ahead
of the Worker's 16:45 dispatch. Every fast week masked both defects; only a
long-running pipeline exposes them.

## Scope decisions

1. **Briefing, digest and evening only.** Earnings previews already received an
   aliveness gate (`mac-recent-earnings-sweep`, 2026-08-05). Earnings recaps stay
   deliberately un-gated per the standing decision in CLAUDE.md — they are
   additive, already deduped by per-event markers, and time-critical after a
   print. This spec does not touch any earnings path.
2. **Heartbeat with a 15-minute grace.** A live Mac holds the cloud off for as
   long as it needs; a dead Mac frees the cloud within 15 minutes, after which
   the existing catch-up sweep (briefing 17:00–22:00, digest 9:00–12:00, evening
   20:00–23:00 / Fri 18:00–22:00) ships the cloud copy.
3. **No subject labeling, and the Mac never suppresses its own send.** Fixing the
   race is the whole remit. A late cloud-marker re-check that suppressed the Mac
   would have meant receiving *only* the degraded copy on 2026-08-09, which
   inverts the goal.

## Design

### New unit: `withRunningMarker`

Added to `lib/cron/running-marker.ts`. It holds the marker for exactly the
lifetime of `fn` and knows nothing else about the send pipeline.

```ts
const HEARTBEAT_MS = 2 * 60 * 1000;

export async function withRunningMarker<T>(
  type: JobType,
  fn: () => Promise<T>,
  opts?: { heartbeatMs?: number },
): Promise<T> {
  await setRunningMarker(type);                    // awaited: the loop is free at entry
  const beat = setInterval(
    () => { void setRunningMarker(type); },
    opts?.heartbeatMs ?? HEARTBEAT_MS,
  );
  beat.unref?.();                                  // must never hold the process open
  try {
    return await fn();
  } finally {
    clearInterval(beat);
    await clearRunningMarker(type);
  }
}
```

`JobType` is the existing `"briefing" | "digest" | "evening"` union already used
by `setRunningMarker` / `clearRunningMarker`.

The heartbeat and the TTL solve different halves of the problem and neither is
redundant: the heartbeat covers unbounded pipeline growth, so no constant can
silently age out again; the 15-minute TTL covers individual beats lost to event
loop starvation. Either alone leaves a hole.

### Route changes

`app/api/cron/{briefing,digest,evening}/route.ts` — all three share an identical
shape today. Each replaces its scattered `void setRunningMarker(...)` plus
`finally { void clearRunningMarker(...) }` with one wrapper call, and moves
`confirmMacSent` inside the callback, awaited:

```ts
const result = await withRunningMarker("briefing", async () => {
  const r = await sendBriefingEmail(db, { ... });
  if (r?.success && !r.skipped) await confirmMacSent("briefing");
  return r;
});
```

This also closes a pre-existing gap. Today `void confirmMacSent(type)` and
`void clearRunningMarker(type)` start together; if the DELETE lands before the
PUT there is a sub-second window in which neither marker exists and a Worker tick
would fire a fallback. Awaiting the confirm inside the wrapper guarantees
`mac-sent` is written while `mac-running` is still held, so the handoff never has
a gap. Under a naive wrapper conversion the gap would widen, not close — the
wrapper's `finally` runs before the route's `confirmMacSent` would have started.

`tryAcquireSendLock` / `releaseSendLock` and the entry `checkCloudMarker` call are
unchanged.

### Worker change

`workers/cron/src/dedup.ts`: `RUNNING_TTL_SECONDS` from `10 * 60` to `15 * 60`.
The module's header comment documents the 10-minute figure and its "outlive a
5-min Mac pipeline" rationale; both need updating to describe the heartbeat.

The TTL is applied Worker-side when it writes the KV key, so the Mac cannot set
it. This change requires `npx wrangler deploy` from `workers/cron/` — without the
deploy the Mac-side heartbeat still works, but the grace window stays at 10
minutes.

## Error handling

The existing invariant — never block email delivery on Worker RTT — holds at
every rung.

| Failure | Behavior |
|---|---|
| Initial `set` fails (Worker down, 3s timeout) | Already swallowed inside `callRunningMarkerEndpoint`; `fn` runs anyway. Degrades to current behavior; strictly no worse |
| A heartbeat beat fails | Swallowed; next beat retries in 2 min. One success per 15 min suffices |
| `fn` throws | `finally` clears interval and marker; the error propagates unchanged |
| `clear` fails | Marker self-expires within 15 min |
| `WORKER_MARKER_URL` / `CRON_SHARED_SECRET` unset | Every call no-ops at the top of `callRunningMarkerEndpoint`; the wrapper degenerates to `await fn()`. Dev and test unaffected |

Awaiting `clearRunningMarker` adds at most 3s after a send when the Worker is
unreachable. That cost buys deterministic ordering of the `mac-sent` handoff and
is accepted.

## Testing

Extends three existing files: `tests/cron/running-marker.test.ts`,
`tests/api/cron-evening.test.ts`, `workers/cron/test/dedup.test.ts`.

The load-bearing regression pin is the one that would have caught 2026-08-09:

- **A pipeline occupying more than the old 10-minute TTL still holds a live
  marker at minute 14.**

Alongside it:

- the initial `set` resolves before `fn` begins (the missing-`await` pin);
- the heartbeat renews across a long `fn` under fake timers;
- interval and marker are both released on success **and** when `fn` throws;
- an initial-set failure does not prevent `fn` from running;
- `confirmMacSent` resolves before `clearRunningMarker` is called;
- a constant pin asserting `RUNNING_TTL_SECONDS === 900`, in the same idiom as
  the repo's existing Worker parity pins.

The full root suite (`npx vitest run`) and the Worker suite (`npx vitest run` in
`workers/cron/`) must both pass before commit.

## Non-goals

- Earnings previews, recaps, the morning debrief and reporter recaps — untouched.
- Worker dispatch minutes (`EXPECTED_MINUTE_*`) — unchanged.
- Email subject lines — unchanged on both the Mac and Worker sides.
- Mac-side suppression when the cloud already sent — explicitly rejected.
- `checkCloudMarker`, `send-mutex`, and the Worker catch-up sweep — untouched.

## Verification

The Monday 8:45 ET digest is a free end-to-end check that sends nothing extra:
if `mac-running-digest-<date>` is still present in KV at 9:00 when the Worker
dispatches — where today it would have expired at 8:55 — the fix is confirmed on
real traffic. The Sunday briefing at 16:30 ET is the second confirmation.

## Files touched

| File | Change |
|---|---|
| `lib/cron/running-marker.ts` | Add `withRunningMarker` + `HEARTBEAT_MS` |
| `app/api/cron/briefing/route.ts` | Adopt wrapper; await `confirmMacSent` inside it |
| `app/api/cron/digest/route.ts` | Same |
| `app/api/cron/evening/route.ts` | Same |
| `workers/cron/src/dedup.ts` | `RUNNING_TTL_SECONDS` 10 → 15 min; update header comment |
| `tests/cron/running-marker.test.ts` | Wrapper behavior + regression pins |
| `tests/api/cron-evening.test.ts` | Ordering assertion |
| `workers/cron/test/dedup.test.ts` | TTL constant pin |

## Risks

- **Heartbeat starved beyond 15 minutes.** A single synchronous block longer than
  the full TTL would still drop the marker. The longest observed block on
  2026-08-09 was 215.6s, well inside the window. If this ever recurs, the next
  step is an out-of-process heartbeat rather than a larger constant.
- **Deploy coupling.** The Mac-side and Worker-side changes ship independently.
  Landing only the Mac side leaves a 10-minute grace window — better than today,
  but not the designed behavior. The Worker deploy is part of the same change.
