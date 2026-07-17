# End-of-day earnings wrap — design (#17)

**Date:** 2026-07-16
**Status:** Approved pending user spec review (earnings-batch session 2026-07-16)
**Extends:** `lib/calendar/email-sweep.ts` single-source sweep + the earnings marker dance

## What

On a day where **≥3 recap emails would fire in the same release slot**, the
individual recaps are suppressed and consolidate into ONE wrap email per
slot — full per-name recap prose stapled under a combined scoreboard index.
The wrap sends at the first sweep tick where every expected recap in the
cluster is complete, or at the slot deadline. Mirrored on the Worker
(Mac-asleep path) with the same suppress-and-staple semantics.

## Decisions (locked with user, 2026-07-16)

- **Suppress + deadline wrap** — individuals held on wrap days; volume goes
  from N emails to 1. Real-time awareness stays covered by push-at-print.
- **Full per-name recap prose, stapled** — each name gets the existing
  recap composer's output (not a thinner synthesis). Same AI cost as today,
  one email.
- **Per-slot clusters** — the ≥3 threshold applies per (date, slot): a
  3-bank BMO morning wraps at ~11:00; a 3-name AMC evening wraps that
  night; a mixed 2+2 day wraps nothing (all four send individually).
  Morning analysis never waits for the evening.
- **Full cloud mirror** — the Worker also counts, suppresses, and staples
  (its compact B8 recap form) when the Mac is asleep.

## Semantics

### Cluster definition

`(event_date = todayET(), slot)` where slot uses the established
event_time/title/release_time precedence (BMO / AMC). **TBD-slot events
never join a cluster** — they send individually (an unknown release time
can't participate in a completion race). Expected-recap count for a
cluster = held/watchlist recap-eligible events (family-deduped, not
superseded, not skipped via `earnings_email_skips`, not muted, recap not
already sent). Count evaluated fresh each sweep tick — a mid-day manual
add can flip a cluster into wrap mode before any individual recap fired.

**Edge rule — late flip:** if an individual recap already went out (count
was <3 when it fired) and a later add pushes the cluster to ≥3, the wrap
covers only the REMAINING names; already-sent recaps are excluded (their
audit rows exist) and the wrap notes nothing about them. No clawbacks.

### Wrap lifecycle (per cluster, inside runEarningsEmailSweep)

1. **Suppress:** a recap candidate whose cluster is in wrap mode is skipped
   with a new benign `SweepSummary.skipped` reason `wrap_pending`
   (`ok: true` — never counted as failure).
2. **Readiness:** the wrap fires when EVERY expected event is
   recap-ready (actual captured + `enriched_at` stamped — the same gate an
   individual recap uses) — OR the slot deadline passes: **BMO 12:00 ET,
   AMC 20:00 ET** (user-set 2026-07-16; both re-checked on each 15-min
   tick — the launchd enrichment tick runs 24/7). Worker ripple: the
   cloud earnings gate (`shouldRunEarningsFallback`, Mon-Fri 05:00-20:00
   ET) ends exactly AT the AMC deadline, so the cloud deadline path could
   never fire — the gate extends to 20:59 ET (same shape as the B8
   18:00→18:59 extension).
3. **Deadline behavior:** events still blocked at the deadline are listed
   in a deterministic "Still waiting on actuals" section (symbol + last
   known state) and are NOT marked sent — once their actuals land, the
   ordinary individual recap fires (wrap mode for the cluster ends at
   wrap-send). The existing blocked-recap Pushover keeps firing for them.
4. **Claims:** the wrap claims every ready event's `earnings_emails` recap
   row (the migration-063 `claim_token` mechanism, one claim per event)
   BEFORE composing. Any claim conflict → release the ones it took, skip
   this tick, retry next (another process is mid-send; the 30-min stale
   takeover covers crashes).
5. **Compose:** deterministic combined index (one `renderHeadlineTable`
   scoreboard per name, in release order), then per-name `# SYM` sections
   containing the FULL existing recap composer output. Requires a
   compose-only seam extracted from `sendEarningsEmail` (see Architecture).
6. **Send:** one email, subject `Earnings wrap — {BMO|AMC} {date} ({N}
   names)`, `fromLocalPart: "earnings"`.
7. **Audit:** one `earnings_emails` recap row PER EVENT (not per wrap),
   each with `ai_output_md` = that name's own prose section — the in-app
   `EarningsEmailViewer` keeps working per event unchanged. Claims
   released by the same token.
8. **Markers:** per-event `mac-sent-earnings-recap-{eventId}` markers
   written as today (per-event Mac↔cloud dedup unchanged) PLUS a
   cluster-level `{mac,cloud}-sent-earnings-wrap-{slot}-{date}` marker
   pair with the same check-before/write-after dance. The Mac pre-checks
   the cloud wrap marker; the Worker pre-checks both Mac markers.

### Worker mirror (`workers/cron/src/fallback-earnings.ts`)

Same cluster count from `snapshot.calendarEvents` + same-day KV
`cloud-enriched-*` payloads (the B8 readiness source); suppression of
individual cloud recaps under wrap mode; stapled email uses the existing
compact cloud recap renderer per name. One send instead of N is a NET
subrequest saving; the existing `MAX_CANDIDATES_PER_RUN=5` cap applies to
the wrap's name count (>5-name cluster: wrap includes the 5 closest, the
rest defer to the next tick — logged, the B13 rule). Per-event
`cloud-sent-earnings-recap-*` markers still written so the Mac's
sent-by-cloud audit backfill works with ZERO changes.

## Architecture

- `lib/earnings/wrap.ts` (new): pure cluster logic — `clusterKey(event)`,
  `expectedRecapCluster(db, date, slot)`, `isClusterReady`,
  `slotDeadlinePassed(slot, now)` (ET via date-utils, injectable now).
- `lib/digest/send-earnings-email.ts`: extract
  `composeEarningsEmailContent(db, event, phase)` → `{subject, markdown,
  html}` used by BOTH the single-send path (behavior byte-identical) and
  the wrap. The claim dance stays in the callers.
- `lib/calendar/email-sweep.ts`: wrap-mode branch in the recap loop +
  wrap readiness/send step. All existing marker/claim/reap semantics
  untouched for previews and non-wrap recaps.
- `workers/cron/src/fallback-earnings.ts`: mirror of the cluster logic
  (small pure functions duplicated + parity-tested where shared shape
  allows).

## Failure modes

| Failure | Behavior |
|---|---|
| One name blocked at deadline | Wrap sends without it + "Still waiting" line; its individual recap fires later |
| Claim conflict mid-wrap | Release taken claims, retry next tick |
| Compose failure for one name | That name degrades to scoreboard + "compose failed" note; wrap still sends (never lose N-1 finished recaps to 1 failure) |
| Mac asleep all evening | Worker wrap fires from KV payloads; Mac backfills per-event audit rows on wake |
| Exactly at threshold with a skip/mute | Skipped/muted names don't count toward the 3 |

## Testing

Cluster counting (slots, skips, mutes, family dedup, TBD exclusion,
late-flip), suppression skip reason, readiness + both deadlines,
still-waiting section, claim conflict retry + release, per-event audit
rows + viewer compatibility, late-finisher individual send post-wrap,
marker dance both directions, Worker mirror (count, staple, cap, marker
writes, pre-v10 snapshot indifference — wrap needs no new snapshot
fields), compose-seam regression (single-send byte-identical).

## Out of scope

Wrap threshold as a user setting (constant `WRAP_THRESHOLD = 3`), wrapping
previews, cross-day clusters, retro-consolidating already-sent recaps.
