# Read-through reporter recap email — design

**Date:** 2026-08-03
**Status:** Approved by user (fire at first actuals; purely deterministic — zero AI)
**Origin:** Earnings feedback backlog #3 (user review 2026-08-02): PRLB printed Friday 7/31 BMO and nothing arrived — the user watched PRLB up / XMTR down pre-market with no email. A pure read-through reporter (not held, not watchlist) whose print moves a held target deserves a lean recap ASAP, not just a push and a block in the target's later preview.

## Decisions (user-approved 2026-08-03)

- **Fire at first actuals** — the first 15-min sweep tick after Finnhub posts the print (~T+15–30 min; before the open for BMO). The reaction snapshot is NOT waited for; the email notes it's pending and the in-app viewer (which rebuilds the scoreboard live) picks it up once enrichment completes.
- **Purely deterministic** — zero AI anywhere. Scoreboard, beat/miss Δ, the user's own hypothesis text verbatim, target presence. No model dependency, nothing to time out.

## Design

### Candidacy — third class in `findEmailCandidates`

`EmailCandidate` gains `reporterRecap?: true`. New SQL road (mirrors the recap road's shape):

- `event_type='earnings'`, not superseded, `symbol` non-null
- `actual_value IS NOT NULL` — **no `enriched_at` requirement** (that's the ASAP part; the normal recap road keeps its enrichment gate)
- `event_date BETWEEN yesterday AND today` (self-healing for an asleep morning; older prints have decayed value and are skipped silently)
- no `earnings_emails` recap audit row, no recap skip row (cross-source deduped like the other roads)

Post-filters (JS): symbol **NOT** held/watchlist (`getSymbolStatus` — covered names get the full AI recap; `UNIQUE(event_id, phase)` prevents double-sends in any race), `shouldSendEarningsEmail` (muting the reporter mutes this), and `getLiveReadThroughsForReporter(db, symbol).length > 0` (pair counts only while its target is currently held/watchlist — exits self-narrow the gate, same as push-at-print).

### Composer — `lib/earnings/reporter-recap.ts` (deterministic)

- Subject: `📡 {SYM} printed — read-through to {TARGETS}`
- Body: `renderHeadlineTable(event, symbol, "recap")` (existing deterministic scoreboard — consensus vs actual with Δ; `isPlausibleEarnings` blanking inherited). When `reaction_snapshot` is null: a line *"Reaction snapshot pending (~HH:MM ET) — the in-app viewer updates once enrichment completes."* (release instant + 2h; omitted when no release instant).
- Per-pair block (weight-ordered): target symbol + held/wl status + hypothesis text verbatim + the target's own next scheduled print when on the calendar ("XMTR reports Tue Aug 4 (BMO) — this print lands first").
- Target positions in the direction-only presence format (`formatPositionPresence` — cc-recipient privacy convention).
- Footer notes the email is fully deterministic (no AI interpretation — the hypothesis is the user's own).
- **Plausibility hard gate**: when EVERY captured actual is flagged implausible vs consensus, do NOT send and do NOT write an audit row — return the benign `not_ready` 409 so a corrected actual retries (better no email than a wrong one; retry noise is the same benign-skip class as `wrap-pending`).

### Send path — `sendReporterRecapEmail(db, eventId)`

Same discipline as `sendEarningsEmail`: claim the `(event, 'recap')` slot BEFORE compose (`claimEarningsEmailSlot`, token-conditional release on failure), compose (pure), send via `lib/email.ts::sendEmail` (`fromLocalPart: "earnings"`, recipient precedence as the sweep's other sends), complete the audit row with the full markdown as `ai_output_md` (so `EarningsEmailViewer` + EarningsHub chips work unchanged).

Sweep integration in `runEarningsEmailSweep`'s per-candidate loop: reporter candidates ride the existing Mac↔cloud marker dance (cloud-sent check → running marker → send → mac-sent → clear running) — the Worker never sends these in v1, but the dance is cheap and future-proof. **The wrap-suppression branch exempts `reporterRecap` candidates**: a heavy held-name night must not defer the timely read-through signal into a debrief that (by its held/watchlist gate) would never cover it.

### Non-goals

- No Worker cloud fallback (push-at-print already fires from the cloud with the read-through flag; follow-up if a real miss is observed).
- No reporter previews (the target's preview carries the read-through block).
- No debrief coverage (non-held by definition).
- No AI.

## Testing

- Candidate-gate matrix: fires on actuals-without-enrichment; excludes held/watchlist symbols, muted reporters, no-live-pair reporters, audited/skipped events, stale dates.
- Composer: scoreboard present, pending-reaction line (and its omission when reaction captured / no release instant), hypothesis verbatim, target next-print line, presence-only positions (no counts), plausibility hard gate (no send, no audit).
- Send path: claim/release semantics, audit row stores markdown, benign 409s.
- Sweep: reporter candidate exempt from wrap suppression; marker dance exercised.
- Full Mac suite green (Worker untouched).
