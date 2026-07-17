# Read-through push at print — design (#13)

**Date:** 2026-07-16
**Status:** Approved (earnings-batch session 2026-07-16)
**Extends:** Wave 1 §2 push-at-print (`docs/superpowers/specs/2026-07-05-earnings-wave1-design.md`)

## What

When a `read_through_pairs` reporter prints, the push-at-print notification
carries the read-through to the user's held/watchlist target(s) — and fires
even when the reporter itself is NOT held/watchlist (today it's dropped by
the held/watchlist gate, so the entire read-through case silently misses).

```
TER reported — read-through
EPS 1.42 vs 1.35 est · Rev 775.2M vs 762.0M · TER +4.10% vs SPY +0.20% (T+2h)
→ PRTO (held): on-demand parts margins move on the same input-cost cycle
```

## Decisions (locked with user, 2026-07-16)

- **One push per print** — extend the existing print push with read-through
  lines rather than a second notification. Existing per-event KV marker
  dedup covers all sites.
- **Hypothesis included**, truncated (~140 chars). Rule amendment: push
  content is public market data **plus read-through target symbols + the
  user's own curated hypothesis text** — never quantities or values.
- **Worker mirror: yes** — additive `readThroughPairs` snapshot field (the
  v8 `watchlistSymbols` pattern); pre-field snapshots degrade to no rt
  pushes for ≤24h.

## Architecture

### Live-pairs helper — `lib/alerts/read-through-push.ts` (new)

`getLiveReadThroughsForReporter(db, symbol)` →
`{ target, targetStatus: "held" | "watchlist", hypothesis }[]`:

- Reporter match is family-aware (`issuerSiblings`) against
  `read_through_pairs.reporter_symbol`.
- Targets filtered through `getSymbolStatus` — only currently held/watchlist
  targets survive (a pair whose target was exited contributes nothing, so
  the widened gate stays narrow). Held wins over watchlist.
- Weight DESC, capped at 3.

### Composer — `lib/alerts/print-push-message.ts` (+ Worker byte-parity mirror)

Input gains `readThroughs?` (the helper's shape) and `readThroughOnly?:
boolean`. Rendering: the existing ` · `-joined stats line, then one
`→ TARGET (status): hypothesis` line per entry (hypothesis truncated at 140
chars with an ellipsis; omitted entirely when null). Title gains
` — read-through` when `readThroughOnly`. Stays zero-import; change BOTH
files together (parity-tested).

### Gate widening — three fire sites

- Mac `lib/calendar/enrichment-runner.ts` + `lib/calendar/cloud-reconcile.ts`:
  `(status held/watchlist OR liveReadThroughs.length > 0) && shouldSendEarningsEmail(...)`.
  `readThroughOnly = !(held || watchlist)`. Muting the REPORTER symbol still
  mutes its push (unchanged semantics).
- Worker `workers/cron/src/calendar-enrich.ts`: same widening from
  `snapshot.readThroughPairs` (family-aware via the Worker `issuerSiblings`
  mirror, target status from held/watch sets, weight sort + cap 3 —
  duplicated small logic, pinned by tests on both sides).

### Snapshot — additive `readThroughPairs`

- `workers/cron/src/state.ts`: `readThroughPairs?: { reporter: string;
  target: string; weight: number; hypothesis: string | null }[]` +
  schemaVersion bump (v8/v9 precedent).
- `scripts/snapshot-state-to-r2.ts`: ship all pairs (table is small,
  user-curated).

### Docs

CLAUDE.md print-push bullet amended with the widened gate + content rule.

## Failure modes

| Failure | Behavior |
|---|---|
| Pair's target no longer held/watchlist | Pair dropped; reporter may not push at all |
| Reporter muted / master toggle off | No push (unchanged) |
| Snapshot lacks readThroughPairs | Worker pushes keep today's held/watchlist-only gate |
| >3 live pairs | Top 3 by weight |

## Testing

- Composer (Mac + parity): rt lines, status label, 140-char truncation,
  cap 3, `readThroughOnly` title, no-rt output byte-identical to today.
- Helper: family-aware reporter match, exited-target filtering, held-wins
  status, weight sort + cap.
- Runner + reconcile: non-held rt reporter fires; rt reporter with no live
  target doesn't; held reporter gets lines appended; muted reporter silent.
- Worker: snapshot-pairs assembly, family match, pre-field degradation.

## Out of scope

Read-through surfaces in the recap email (already exist), a second
notification channel, per-pair mute controls, storing push history.
