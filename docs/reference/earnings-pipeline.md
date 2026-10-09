> Archived from CLAUDE.md on 2026-08-10. All facts preserved; read when working in this area.

# Earnings pipeline

Everything about the earnings road: calendar-event enrichment, actuals capture, wire/release times,
date+slot verification, the email sweep and its claim mutex, previews/recaps/debrief, read-throughs,
push-at-print, and the printed worksheet.

Contents:

1. [Enrichment is retry-until-complete](#1-enrichment-is-retry-until-complete)
2. [Finnhub data quality — guard at the consumer](#2-finnhub-data-quality--guard-at-the-consumer)
3. [Release times](#3-release-times)
4. [Wire-time tracking](#4-wire-time-tracking)
5. [Earnings date/slot verification](#5-earnings-dateslot-verification)
6. [`getSymbolStatus` — "held" = ANY exposure](#6-getsymbolstatus--held--any-exposure)
7. [Email sweep — single source + claim mutex](#7-email-sweep--single-source--claim-mutex)
8. [Per-event email skip](#8-per-event-email-skip)
9. [Earnings source hierarchy](#9-earnings-source-hierarchy)
10. [Read-through pairs](#10-read-through-pairs)
11. [Read-through reporter recap](#11-read-through-reporter-recap)
12. [Push-at-print composer](#12-push-at-print-composer)
13. [Print-sheet pipeline](#13-print-sheet-pipeline)
14. [`renderSheetBogeysBlock` — deterministic per-source bogeys table](#14-rendersheetbogeysblock--deterministic-per-source-bogeys-table)
15. [Notes-are-sacred across all earnings print roads](#15-notes-are-sacred-across-all-earnings-print-roads)

---

## 1. Enrichment is retry-until-complete

*(2026-07-05, migration 062)*

Earnings rows (`source='finnhub'` OR `event_type='earnings'`) retry **every** enrichment tick
(10-min pacing via `calendar_events.enrichment_attempted_at`) until COMPLETE.

- **COMPLETE** = actual captured AND (reaction captured OR release ≥150 min ago;
  `REACTION_SETTLE_MS` = `REACTION_RECAPTURE_HORIZON_MS`).
- `enriched_at` stamps **ONLY** on completion, which is what opens the recap `[enriched_at, +4h]`
  window — so recaps go out after the call, and a blocked row (`enriched_at` NULL) is reopened by a
  manual `POST /api/earnings/actuals`.
- Macro rows keep single-shot semantics exactly.

### Reaction-capture gate

**No reaction is captured before release plus two hours, for every row (owner ruling 2026-10-08).**
A reaction is the move from just before a release to the price 120 minutes after it. Until that
moment has passed there is nothing to measure. `REACTION_READY_MS` (`lib/calendar/enrichment-runner.ts`,
120 minutes) gates earnings AND macro rows; the Worker carries the same constant
(`workers/cron/src/cloud-enriched.ts`, used in `calendar-enrich.ts`). History: the gate was 115
minutes and earnings-only, and macro rows were never gated, so a macro row could store a "reaction"
read minutes after its release.

- **Each stored snapshot records when it was captured** (`captured_at`, both sides).
  `admitCapturedReaction` is the last check before a write.
- **Reaction-only follow-up** (`runReactionFollowUp`). The main pass only sees rows with
  `enriched_at IS NULL`. A row marked done before its window ended (every macro row is; an earnings
  row is when a cloud actual stamps it early) gets its reaction between release + 120 and release +
  150 minutes. The follow-up writes `reaction_snapshot` only where it is still NULL, never fetches an
  actual, never touches `enriched_at`, and never sends anything.
- **One home for "is this a measurement yet?":** `lib/calendar/reaction-validity.ts`. The capture
  gate, the cloud reconcile (`assessReactionSnapshot`) and the on-screen chips (`reactionLegState`,
  which show "pending", never a percent) all read it. For an older snapshot with no `captured_at`,
  a pre/post pair with the identical price is not trusted, and a leg that rounds to zero on a row
  stamped before its window could have been measured is not trusted either.
- **Every reader that turns a snapshot into text goes through `readReactionLegs`** (same file): the
  earnings email composer (scoreboard, recap prompt, read-through bullets), the weekly briefing,
  the macro-themes event line, the chat tool and the email viewer's rebuilt scoreboard. It returns
  the measured legs and names the pending ones. **Outbound text and prompts omit a pending leg;**
  when no leg is measured the recap uses its not-yet-captured wording. Only in-app surfaces (the
  email viewer, the chat tool, the chips) may say "pending". The push composer
  (`lib/alerts/print-push-message.ts`) is import-free by design and carries its own copy of the
  snapshot-only part of the rule, as does its Worker mirror. A snapshot whose legs are all
  measured renders exactly as before.
- **The Worker's recap has its own copy of the leg rule** (second half of the 2026-10-08 sprint):
  `workerReactionLegState` (`workers/cron/src/fallback-earnings.ts`). The cloud scoreboard, its
  expected-move row and the recap gate read it. The gate (`evaluateRecapContent`) asks for "at
  least one real data point"; a pending leg renders a dash, so it is not a data point, and an
  implausible actual with only pending legs sends nothing. The copy is pinned against the Mac's
  `reactionLegState` by a 900-case table (15 snapshot shapes, 6 leg shapes, 10 enrichment stamps)
  in `workers/cron/test/fallback-earnings.test.ts`. Change both sides together and deploy the
  Worker.
- **The chat tool can judge an old zero move:** the release-reactions query selects the row's
  enrichment time, so a 0.00 percent leg on a row stamped before its window ended reads as pending
  (`tests/chat/release-reactions-legacy-zero-move.test.ts`).
- **Repair script, written and not run:** `scripts/repair-premature-reaction-snapshots.ts`
  (dry-run default) lists stored snapshots that were captured too early.

Tests: `tests/calendar/reaction-validity.test.ts`,
`tests/calendar/reaction-pending-text-readers.test.ts`,
`tests/calendar/enrichment-runner-reaction-window.test.ts`,
`tests/calendar/cloud-reconcile-reaction-validity.test.ts`, `workers/cron/test/calendar-enrich.test.ts`.

### Do not regress

Never re-introduce unconditional `enriched_at` stamping. The pre-fix single shot at T+15min killed
10 recaps + all TWS reactions in the Apr–Jun season.

### Cloud reconcile

`lib/calendar/cloud-reconcile.ts` is **ADD-only**: COALESCE on actual/reaction, `deferred`/empty
payloads drained without writes, reaction-only payloads never stamp `enriched_at`.

---

## 2. Finnhub data quality — guard at the consumer, not the writer

Finnhub `epsActual`/`revenueActual` drift both directions post-release, so `fetchFinnhubActual`
(`lib/calendar/enrich-actuals.ts`) writes raw — auto-overwrite would corrupt real values.

- Validate at **consumers** via `isPlausibleEarnings` — single source `lib/earnings/plausibility.ts`
  (zero-import by design; byte-parity Worker mirror `workers/cron/src/plausibility.ts`,
  parity-tested; re-exported from `send-earnings-email.ts` for legacy importers — **change BOTH
  files together**).
- `scripts/audit-finnhub-actuals.ts` is read-only (`--fix` is a last resort, **NOT** a cron).
- Use `POST /api/earnings/actuals` for overrides; `earnings_bogeys` is the user-curated alternative.
- A manually-stamped actual (`calendar_events.manual_actuals_at`) bypasses the plausibility guard on
  **outbound** roads too, not just reads — reporter-recap send gate, recap headline table, recap
  prompt, and the Worker read-through builder all route through `actualsAreImplausible`
  (`lib/earnings/actuals-display.ts`); the Worker's `evaluateRecapContent` carries the same bypass,
  parity-pinned. `plausibility.ts` itself stays byte-parity (`23a8028`).

---

## 3. Release times

`lib/calendar/release-times.ts` — `RELEASE_TIMES_ET` (macro `event_type` → ET) +
`SYMBOL_RELEASE_TIMES_ET` (per-ticker, **consulted FIRST**).

`resolveReleaseTime` / `earningsHourToReleaseTime` + `deriveReleaseTime` (`lib/mutations/calendar.ts`)
thread the symbol through. Add a symbol via the constant + `scripts/backfill-symbol-release-times.ts`.

---

## 4. Wire-time tracking

*(migration 076, spec 2026-08-04)*

Earnings release times resolve through `lib/earnings/wire-times.ts::resolveEarningsReleaseTime`, a
layered cascade:

1. explicit HH:MM `event_time`
2. user standing override (`symbol_release_times`, source `user`, edited in the EarningsDateChip
   popover / `POST /api/earnings/release-time`)
3. `web_verified` row (EarningsWhispers jump-start via the daily date-verification pass; honored
   **only while the symbol has ZERO bounded observations**)
4. derived from bounded `earnings_wire_observations` (earliest first-seen − 10 min, floored to :05,
   04:00 floor)
5. legacy `SYMBOL_RELEASE_TIMES_ET`
6. BMO/AMC defaults

Any observation earlier than a layer-≥3 resolution pulls it down.

**Saving over a web-verified time asks first (2026-10-08).** The table holds one row per ticker. A
Save turns a web-verified row into a user row, and a later Clear deletes that, so the web-verified
time could not come back. `POST /api/earnings/release-time` therefore answers 409
`would_replace_web_verified` and stores nothing until the body carries `replaceWebVerified: true`
(`checkUserSaveWouldReplaceWebVerified`, same file). The popover asks through the app dialog. The
slot check (`slot_mismatch`) still runs first and has no bypass; the acknowledgement answers only
this one question. A web-verified after-close time at or after 17:00 is a suspect call time and
is replaced without a question. GET also returns `overrideUse`: whether the resolver actually uses
the standing row for that slot (`standingReleaseTimeUse`). Tests:
`tests/api/earnings-release-time.test.ts`, `tests/earnings/wire-times.test.ts`,
`tests/dashboard/release-time-editor-u17.test.ts`.

### Pre-release probe

`runEnrichment` runs a pre-release Finnhub probe (T−90m, cap 6/tick, held/watchlist/reporter only):

- empty probes stamp `calendar_events.wire_probe_empty_at` (observation bounding)
- a positive probe pulls the event's `release_time` earlier and **captures actuals SAME tick**
- observations record on the null→non-null actual transition (bounded only when an empty probe ran
  ≤30 min prior — a late-waking Mac records honestly as "at or before")
- macro rows are untouched everywhere
- probe attempts never stamp `enrichment_attempted_at`

### Follow-ups batch (2026-08-05, `87f524f..6f53f2b`)

- The actuals road (`fetchFinnhubActual`) **PROPAGATES** fetch errors instead of swallowing them into
  "legitimately empty". The probe road stays fail-open and never stamps `wire_probe_empty_at` on a
  FAILED fetch — an error is not an empty probe.
- Exact-time verdicts are family-aware + case-insensitive (writes are uppercase-canonical via
  `upsertSymbolReleaseTime`; every `symbol_release_times` reader is `issuerSiblings`-aware).
- Conflict-confirm (`lib/mutations/confirm-earnings-date.ts`) routes through the cascade with its
  input built **FRESH** from the user's confirmation (no circularity with the row being corrected).
- The conflict popover carries the same "Reports at" editor as the passive popover (hoisted
  `ReleaseTimeEditor` — **never define it inside the component body**).
- The sync upsert keeps an EARLIER existing earnings `release_time` (earnings-only CASE, macro
  COALESCE byte-identical + test-pinned). Accepted trade-off: a wrong-EARLY vendor slot can't be
  repaired by re-sync — the daily verify pass writes directly and self-heals it ≤1 day.
- `wire_probe_empty_at` is protective state in `deleteUnenrichedEventsForWeek`.
- Daily verification cap is **12** (was 8 — saturated 3 of its first 4 live days).
- Worker-parity note: the Worker's `fetchFinnhubActual` **still swallows errors** (pre-existing,
  absorbed by retry-until-complete; future parity touch).

---

## 5. Earnings date/slot verification

*(migration 072, 2026-08-02)*

`lib/calendar/verify-earnings-dates.ts` verifies upcoming held/watchlist/read-through earnings dates
+ slots via Claude `web_search` **once per ET day** (gate opens 05:00, hooked after the earnings
sweep; settings key `earnings_date_verify_last_run`; CLI `scripts/verify-earnings-dates.ts`, dry-run
default).

### Caller contract

`runEarningsDateVerification`'s `apply` is **REQUIRED** — the pass deletes + suppresses rows, so
intent is stated by every caller, never defaulted.

### Candidate selection

- Candidates **SKIP `source='manual'` rows** — user-authored + verifier-minted corrections are not
  the AI's business. Accepted consequence: a corrected row isn't re-verified; an adopted vendor row
  still is.
- A stamped row **re-opens once its print is within 2 days and its stamp is >2 days old** — the T-7
  "no announcement yet" verdict gets one more look at T-2.

### Verdict handling

- `applyVerdict` treats a `confirmed_date` outside `[today, today+37d]` as unconfirmed — never
  corrects on a hallucinated past/far-future date.
- Confirmed mismatches auto-correct through `correctEarningsEventDate` (lib extraction of
  `correct-earnings-date.ts` — suppress + manual, bogeys migrated, refuses on captured actuals, one
  transaction). It **ADOPTS** an existing non-manual row already on the correct date whose slot
  agrees (clears `superseded`, keeps vendor consensus + the Finnhub enrichment road; only when
  `correctDate ≠ wrongDate`, else the suppression would strand the adopted row) and otherwise mints a
  manual row carrying the wrong row's `consensus_estimate` / `expected_impact`.
- **The corrected row is never in its own delete set**: a same-date slot fix selects every row on
  that date, and deleting the adopted/pre-existing manual row would suppress the tuple and lose the
  event unrecoverably.
- Corrections Pushover once per run.

### Manual rows still enrich

`parseSourceKey` routes `manual:SYM:DATE:earnings` down the Finnhub road — **BOTH sides** since
2026-08-02 evening: the Worker mirror `workers/cron/src/enrich-actuals.ts` carries the same regex, so
corrected rows capture actuals while the Mac sleeps.

### A hand-entered row locks by its source; a sync never confirms it (2026-10-07)

Builds the owner's 2026-09-14 ruling. In `lib/calendar/reconcile-earnings-dates.ts`:

- **The lock reads `source = 'manual'`.** A hand-entered row wins its cluster on every pass whether or
  not it carries a confirmation.
- **Only the confirm-date route writes `user_confirmed`** (`lib/mutations/confirm-earnings-date.ts`).
  The reconciler keeps a confirmation a row already carries and writes none otherwise
  (`lockedStatusFor`). Before this, one refresh marked every hand-entered row as confirmed by the user.
- **A hidden hand-entered row keeps a real confirmation.** Hiding a row clears every other status;
  a confirmed hand-entered row that is later restored comes back still confirmed.
- **The Hub chip decides from source and status** (`app/dashboard/today/EarningsDateChip.tsx`): an
  unconfirmed hand-entered row shows "Entered by you" and opens the date, slot and time editor. Do not
  key an edit entry point on `user_confirmed` alone; that status is no longer on every manual row.

Tests: `tests/calendar/reconcile-manual-rows-a14.test.ts`,
`tests/dashboard/earnings-date-chip-hand-entered.test.tsx`. The chip was not seen in a browser.
Both questions left open here on 2026-10-07 were ruled and built on 2026-10-08: a feed twin outside
the reconciler's window is hidden at write (`docs/reference/calendar.md` §5), and on one date a
hand-entered row beats a vendor row the user confirmed, whatever order they were written in
(`resolveCluster`, rung 1).

### Same-date duplicates: a real slot beats a default time (2026-10-08)

Two vendors often list one print. Finnhub sometimes gives no hour, and the sync then stores the
after-close default. Before this ruling the Finnhub row always won an agreeing pair, so a print the
other vendor knew was before the open showed as an afternoon print.

- **The rule lives in one function:** `pickSameDateWinner` (`lib/calendar/reconcile-earnings-dates.ts`).
  Among rows on ONE date, the row the older rule kept stays unless it has no real slot and another
  row on that date has one. A "real slot" is an explicit before-open or after-close marker
  (`hasRealSlot`, read through `deriveEarningsSlot` with no release-time fallback). When both rows
  have a slot, or neither has, nothing changes.
- **It holds after the print too.** Every row on the reported date competes, not only the rows that
  already show an actual. Otherwise the winner flipped back when the first vendor posted its actual.
- **Duplicate check only.** The read-time pickers that prefer one vendor before a reconcile pass
  runs (two of them in the Worker) are unchanged. The loser is hidden by the ordinary fold on the
  next pass; no slot is edited in place.
- **So the kept row is not always Finnhub's.** Do not write a reader that assumes it is.

**What a kept non-Finnhub row needs from its hidden Finnhub twin.** The fold copies consensus,
actual and reaction columns and nothing else. `createFinnhubDataCarrier` adds the rest onto a kept
Nasdaq or hand-entered row: the Finnhub keys of `raw_json` that readers use (symbol, estimates,
fiscal quarter and year), the description text the weekly briefing prompt reads, and the revenue
part of the consensus text (Nasdaq rows only). Rules:

- Only what the kept row lacks is written. The slot, the date and the vendor's actuals are never
  carried.
- Everything carried is recorded on a marker in the kept row's `raw_json` (`finnhub_carried`) and
  follows the Finnhub row from then on: refreshed when it changes, removed when the Finnhub row no
  longer states it. Text a person typed over a carried value is theirs and is left alone.
- A zero revenue estimate is the vendor's placeholder and is never carried.
- A settled pair writes nothing, so a second pass is a no-op.
- **The copy is not durable on its own.** A weekly sync replaces the kept vendor row's `raw_json`
  and description; the reconcile pass at the end of that sync restores the copy.

**A reader that cannot tolerate that gap reads the hidden twin directly.** `findHiddenFinnhubDonor`
returns the hidden Finnhub row for the same print (issuer family, within the clustering distance,
nearest date then lowest id; the carrier uses the same picker, `pickFinnhubDonor`). The vendor
consensus prepare step (`resolveVendorConsensus`, `lib/earnings/prepare-steps/consensus-row.ts`)
reads it and never the copy: reading the copy during a sync looked like the vendor withdrawing its
figures and deleted the event's vendor bogey. "Withdrawn" is concluded only when a Finnhub source
for the print exists and says so.

**The weekly briefing lists the kept row whatever its source** (`lib/calendar/briefing-partition.ts`;
the block between its BEGIN and END markers is carried byte-for-byte in
`workers/cron/src/fallback-briefing.ts`). A share-class pair lists once.

Tests: `tests/calendar/reconcile-slot-beats-default.test.ts`,
`tests/calendar/reconcile-carry-finnhub-data.test.ts`, `tests/earnings/consensus-row-donor.test.ts`,
`tests/calendar/briefing-canonical-earnings.test.ts`,
`workers/cron/test/fallback-briefing-partition.test.ts`.

### Confirming a different date leaves one hand-entered row (2026-10-08)

`confirmEarningsDate` (`lib/mutations/confirm-earnings-date.ts`, behind
`POST /api/earnings/confirm-date`). Before, confirming another date wrote a second hand-entered row
and left the first one showing. Now it looks for the symbol's OTHER showing hand-entered rows for
the same upcoming print (`samePrintManualRows`: this exact symbol, dated today or later, within
`SAME_PRINT_WINDOW_DAYS` of the confirmed date, not yet reported):

- **Exactly one, and the confirmed date is free:** that row MOVES to the confirmed date and keeps
  its id, so its bogeys, emails, skips, arm and notes stay attached (`movedEventId`).
- **Exactly one, and a hand-entered row already sits on the confirmed date:** the confirmed row is
  updated in place, the other row's records are folded onto it (`createTwinFolder`, the
  reconciler's own fold), and the emptied row is DELETED (`deletedEventId`). Hiding it would not
  last: the next pass shows every hand-entered row dated today or later.
- **Before the delete, every table is counted** (`remainingEventDependents`). Each foreign key onto
  a calendar event cascades, so a delete never fails; it would silently take whatever the fold left
  behind. The list of tables is read from the schema, so a table added later is covered. If anything
  is still attached (a preview already sent for the old date, for example) the row is NOT deleted:
  it stays hidden (`foldedEventId`), `note` names what remained for the log, and `notice` tells the
  user in plain words (`keptEntryNotice`).
- **Two or more:** nothing is moved or hidden, and `notice` says so.
- **A typed clock time is kept** when the confirm picks the same slot or names no time. Picking the
  other slot is a deliberate change and stores that slot's default. Two stored shapes count as
  typed: a clock in `event_time`, or a slot word in `event_time` with a non-default clock in
  `release_time` (`typedTimeOf`).
- Sync-owned rows are never moved; the reconcile that follows hides them as before.

**Known gap:** a preview email or skip recorded for the old date stays attached to a moved row, so a
move to a later date gets no second preview. Left on purpose; detaching it changes what is sent and
needs an owner ruling.

Tests: `tests/mutations/confirm-earnings-date.test.ts`, `tests/api/earnings-confirm-date-route.test.ts`,
`tests/dashboard/earnings-conflict-marker.test.ts`.

### Slot floors, not the stored release time (`154eb81`, 2026-08-28)

`lib/earnings/earnings-slot.ts::deriveEarningsSlot` is the single BMO/AMC slot resolver — literal
marker, HH:MM side-of-noon, `TAS` → unknown, `raw_json.entry.hour`; `release_time` is consulted only
when a caller opts in. It now backs the wire-time cascade, this verification pass, and the pre-print
floor.

`checkPrePrintFloor(event, now, {useSlotFloor})` floors an accept-gate check at AMC 16:00 ET / BMO
07:00 ET on the event date instead of the stored `release_time` — which for AMC names is often the
CALL time, not the print (the CRWD/RBRK trap). `saveManualActuals` opts in (print-watch accept
inherits it through its transactional call); reporter-recap keeps `release_time`-basis behavior.

A `web_verified` AMC time ≥ 17:00 ET is a suspect call time: never stored going forward, and an
existing one is ignored by the resolution cascade (`isSuspectAmcCallTime`; user-authored rows are
exempt).

### Stamps and sync interaction

Stamps `date_verified_at` / `date_verification_note`; the sync upsert **CLEARS both** when a source
moves `event_date`. Never edit a sync row's date/slot in place — the conflict clause re-clobbers it.

Single-source (Nasdaq-only) dates are exactly the rows the Conflicts tab cannot catch (RKT 7/30) —
this tier is their only net.

---

## 6. `getSymbolStatus` — "held" = ANY exposure

*(2026-07-05 Wave 1)*

A symbol is **held** when the latest per-(account, security) holdings carry `quantity != 0` in the
stock itself (**shorts count** — a short into a print is exposure) **OR** in an unexpired option
whose `underlying_symbol` matches the issuer family.

Every earnings gate (email sweep, push-at-print, EarningsHub chips, coverage-guard consumers)
inherits this. **Never re-narrow to `> 0` or stock-only** — the B7/B10 fixes exist because both
narrowings silently dropped real exposure.

`getHeldStockSymbols` deliberately keeps `> 0` stock-only semantics for briefing/scan-list surfaces.

---

## 7. Email sweep — single source + claim mutex

`lib/calendar/email-sweep.ts::runEarningsEmailSweep` is the **ONLY** sweep implementation
(`/api/cron/earnings-sweep` + `scripts/sweep-earnings-emails.ts` both delegate). It:

- reaps stale claims,
- runs the Mac↔cloud marker dance per candidate (check cloud-sent → set running → send → write
  mac-sent → clear running in `finally`),
- fires `alertBlockedRecaps` (Pushover once per event via `actual_missing_alerted_at`,
  stamp-before-push).

**Never add an earnings send path that bypasses it.**

### A replaced calendar entry is refused at the claim and again after compose (2026-10-07)

The candidate finders already skip a row with `calendar_events.superseded` set. The send path now
checks too, because a reconcile in another process can replace an entry between the finder and the
send (each send holds a 60 to 180 second AI call).

- **One check:** `lib/digest/send-earnings-email.ts::emailRowRefusal(db, eventId, { refuseIgnoredManualTwin })`.
  It returns `"superseded_event"`, `"ignored_manual_twin"` (the later of two live hand-entered rows),
  `"event_not_found"` or null. These are facts about the calendar row, not `earnings_emails.error`
  states. The list is `EMAIL_ROW_REFUSALS`; callers branch on `isEmailRowRefusal(reason)`, never on
  a hand-written list, so a reason added later cannot be missed at a call site.
- **`event_not_found` (2026-10-08):** there is no calendar row with that id (never there, or
  deleted since the candidate list was built). It is checked FIRST and refused for every caller.
  Before, the claim's insert failed with a raw foreign-key error, because the audit row points at
  the calendar row.
- **Inside the claim:** `claimEarningsEmailSlot` runs the check and the claim in one immediate
  transaction (a savepoint when the caller already holds one; a wrapping caller must use
  `.immediate()`). A refusal returns `{ claimed: false, reason }` and writes nothing. Every claimer
  goes through it: the send service and the morning debrief.
- **After compose:** `sendEarningsCandidate` (`lib/earnings/send-service.ts`) asks again before the
  provider call. On a refusal there the claim is undone the way a failed compose undoes it.
- **Outcome:** `{ outcome: "refused", status, code, reason }`, where `code` is one of the three
  refusal codes. The status is 409 when the entry exists but is not the print's email row, and 404
  for `event_not_found`. The reason sentence names the current entry's date when one is found
  (`findLiveEntryForSupersededEvent`, `lib/queries/earnings-emails.ts`).
- **The sweep names why it skipped (2026-10-08).** A refusal that carries a code is booked under
  its own cause (`ROW_REFUSAL_SKIP`, `lib/calendar/email-sweep.ts`): `entry-replaced`
  (`superseded_event`), `later-manual-entry` (`ignored_manual_twin`), `entry-not-found`
  (`event_not_found`). Waiting will not change any of them. Only a refusal with no code is
  `not-ready` (the compose is waiting on something a later tick may bring). The map is keyed by the
  refusal type, so a new refusal fails the type-check until it is given a name.
- **The later hand-entered row** is refused only when `mode === "sweep"` and in the debrief. The
  two manual modes (`nudge`, `manual`) may still send it.
- **Morning debrief:** a replaced member is dropped at the claim. After `generate` and before
  delivery, `runMorningDebrief` re-checks every claimed member with `emailRowRefusal`. If any is
  refused it sends nothing, releases all claims, restores the day key and returns
  `skippedReason: "member-replaced"`, so the next tick inside the morning window retries. A member
  whose entry was DELETED while the email was being composed is refused the same way
  (`event_not_found`), so a draft that still narrates it is never sent. Test:
  `tests/earnings/event-not-found-send-path.test.ts`.
- **Archive:** `SentEarningsEmail` carries `event_superseded` and `replacement`. The shared
  `app/dashboard/components/SupersededEmailNote.tsx` renders the chip and the same-kind link on the
  Emails view and the security page. The link is found by the reconciler's 14-day cluster rule
  (`SUPERSEDED_TWIN_CLUSTER_DAYS`, pinned to the reconciler's constant by a test).
- **Known limitation:** the Worker fallback does not re-check at send time. See
  `docs/reference/cron-and-workers.md` §11.

### Already-reported preview guard (2026-07-23, IMAX case)

Before the marker dance, every PREVIEW candidate passes a two-layer check — row `actual_value`
non-null, else a live `probeFinnhubActualExists(symbol, event_date)` — because a wrong AMC/BMO slot
from the calendar source (Finnhub **AND** Nasdaq both mis-slotted IMAX) puts the preview window
AFTER the real print, and the window math keys only on the RECORDED release instant.

On detection:

- permanent `earnings_email_skips` row, **plus**
- a `mac-sent` KV marker — **load-bearing**: the Worker preview fallback can't see the skips table;
  without the marker it ships the same wrong-slot preview from the cloud, **plus**
- `skipped:"already-reported"` with `ok:true`.

Best-effort / fail-open: any guard error proceeds to the normal send (false negatives safe, false
positives not); **recaps are NEVER probed**.

Companions:

- the composer skips the preview `forceFresh` intel refresh when `actual_value` exists;
- `cockpitRowsToIntelEvents` also requires actual-stage `pending`, so post-print IV crush can't
  overwrite the recap's priced-in intel anchor even on a wrong slot;
- `renderPreviewPrompt` carries an already-reported web-search backstop paragraph;
- per-symbol slot fixes go in `SYMBOL_RELEASE_TIMES_ET` (IMAX `"07:30"`, wire-verified).

### Cloud-sent audit backfill (2026-07-15)

The sweep's first step drains Worker `GET /internal/cloud-sent-earnings` (lists live
`cloud-sent-earnings-{phase}-{eventId}` markers) into `sent-by-cloud` audit rows **regardless of send
windows**. Pre-fix, a preview cloud-sent while the Mac slept vanished from EarningsHub chips + the
viewer once its window closed (observed 7/14).

Read-only on the KV side **by design**: the marker doubles as the Worker's own send dedup, so the Mac
must **NOT** delete it. The audit row's `INSERT .. DO NOTHING` is the idempotency; a 30h TTL cleans KV.

**A `mac` marker with no local row now answers `already_sent` (slice E, 2026-09-04).** The canonical
send path's cloud pre-check (`sendEarningsCandidate`'s call to `checkEarningsCloudMarker`) short-
circuits on ANY marker `sentBy` value, where the old sweep acted only on `"cloud"` — so a `mac`
marker that outlives a database restore inside its own 30-hour TTL, with the local `earnings_emails`
row it should have been written alongside now gone, reports `already_sent` rather than sending a
second time; this is deliberate (re-sending would be the worse error), and the service logs a
`console.warn` naming the marker as the reason.

### `earnings_emails.error` is a FIVE-state column, NOT a failure flag

Single-sourced in `lib/earnings/email-states.ts` (slice E, migration 092). Never write
`error IS NOT NULL` to mean "this send failed" — three of the five values are healthy.

| Value | Meaning | Live claim? | Blocks an automatic resend? |
| --- | --- | --- | --- |
| `NULL` | completed local send (the provider accepted and the row committed) | no | yes |
| `'in_progress'` | claimed; composing | yes | no |
| `'sending'` | provider call in flight; `provider_message_id` (and, for a fresh claim, the prose) already written | yes | no |
| `'sent-by-cloud'` | Worker delivered (`ai_output_md` NULL — the viewer shows "no local copy") | no | yes |
| `'delivery_unknown'` | terminal; the provider's answer was never received | no | yes (manual reconciliation only) |
| any other string | legacy failure text | no | yes |

Helpers, and which question each answers: `isLiveClaim` / `notLiveClaimSql(col)` — "may this row be
ignored by a reader?"; `isDelivered` — "should a chip say sent?" (legacy text counts);
`isDeliveredStrict` / `deliveredSql(col)` — "did an email definitely go out?" (sentinels only);
`sendStateFor` / `sentByFor` — the display mapping. `tests/repo/no-handrolled-email-states.test.ts`
fails on any of the four literal sentinel strings appearing under `lib/**` or `app/api/**` outside
that module (`app/dashboard/**` is exempt by design — slice F needs the chip words).

**Two claim modes (slice E).** `automatic` (sweep, nudge, debrief) NEVER refires a completed
row. `manual` (`POST /api/earnings/email`) does, and its refire goes completed → `sending` DIRECTLY,
never through `in_progress`, so the 30-minute reaper can never delete a delivered row. The
`UNIQUE(event_id, phase)` row is the **cross-process mutex** — claimed BEFORE compose, now via
`claimEarningsEmailSlot` (`lib/digest/send-earnings-email.ts`), called from
`lib/earnings/send-service.ts::sendEarningsCandidate`, the one path every automatic and manual send
goes through (`debrief-send.ts` batches several events under one claim of its own —
`tests/repo/one-claim-owner.test.ts` pins that short list, and asserts that the deleted
`lib/earnings/wrap-send.ts` stays gone). Since **migration 063** claims
carry a `claim_token` and every transition is compare-and-set on it, so a late finisher can't clobber
a successor's takeover claim.

**The reaper runs two sweeps** at the top of each earnings tick: `in_progress` older than 30 minutes
is DELETED (nothing was sent); `sending` older than 5 minutes is FLIPPED to `delivery_unknown` and
Pushovers once with the stored Message-ID. A `sending` row is NEVER taken over by a claim, however
old — a message may be on the wire. **The flip claims the phase through the SWEEP tick, not one
step later (R-E4b).** `findEmailCandidates` (`lib/calendar/enrichment-runner.ts`) LEFT JOINs
`earnings_emails … AND ee.id IS NULL` on both its preview and recap SELECTs, so ANY existing audit
row — a freshly-flipped `delivery_unknown` row included — removes the event from candidacy; the send
path is never invoked for it in a later pass, so no marker would ever be written from there. So
`reapStaleEarningsEmailClaims` itself returns `flipped: Array<{eventId, phase}>`, and
`runEarningsEmailSweep` writes one mac-sent marker per flip immediately after the reap call
(fail-open, same tick).

### Same-company sibling check (2026-10-08)

Two rows for one print can both be showing for a short time in each weekly sync (a vendor row is
re-written before the reconcile pass hides it again), and they can sit at different times of day.
Each row checked only its own audit rows, so one print could get two previews.
`phaseHandledOnSibling` (`lib/calendar/enrichment-runner.ts`) closes that: `findEmailCandidates`
drops a preview or recap candidate when any OTHER earnings row of the same issuer family on the same
date already has an `earnings_emails` row or an `earnings_email_skips` row for that phase.

- **It can only remove a candidate, never add one.** It reads no state value, on purpose: any audit
  row counts, exactly as for the row's own key.
- Family, not symbol equality (`issuerSiblings`). Not applied to the read-through reporter scan, the
  debrief. The two-hand-entered-rows rule (`manual-twin-email.ts`) is separate.

- **The Worker asks the same question.** `siblingEventIndex` (`workers/cron/src/fallback-earnings.ts`)
  maps each row to the other earnings rows of the same issuer family on the same date, and the
  cloud finder checks each sibling the way it checks the row itself: the snapshot's earnings-email
  rows and the KV markers (Mac sent, cloud sent, Mac running). Known limit: the snapshot does not
  carry skips, so a skip recorded on a sibling is not seen in the cloud (the same limit as a skip
  on the row itself).

Tests: `tests/calendar/findEmailCandidates-sibling-handled.test.ts`,
`workers/cron/test/fallback-earnings-sibling-handled.test.ts`.

Every new reader must exclude live claims via `isLiveClaim` / `notLiveClaimSql`
(pattern: `getSentPhasesForEvents` / `getEmailAudit`) — never a literal.

Benign coordination outcomes still land in `SweepSummary.skipped` with `ok:true` — now
`claim-held`, `not-ready`, `already-sent`, `delivery-unknown` and the three calendar-row skips
(`entry-replaced`, `later-manual-entry`, `entry-not-found`). Never count them as failures, and
`alertBlockedRecaps` respects the muted-symbols setting (no stamp on a muted skip, so unmuting
re-arms).

**One row per (event, phase) — and what each field means when a refire is involved.**
The audit row is a CURRENT-STATE record, not an attempt log (a delivery-attempts table was
considered in the slice E review and deliberately deferred — spec §5 reserves 092 for the two
states). So:

| Field | Meaning |
| --- | --- |
| `provider_message_id` | the RFC 5322 `Message-ID` **we minted and set on the wire** for the LAST ATTEMPT. Not a provider receipt — nodemailer echoes back the header it was given. It is what the mailbox and the Resend log can be searched on. |
| `provider_response` | the relay's own reply line from that attempt (`info.response`, e.g. `250 2.0.0 Ok: queued as …`). This is where a provider-side identifier appears if there is one. A hand-confirmed delivery appends `; confirmed by hand <ISO>`. |
| `ai_output_md` | the last DELIVERED body. A refire replaces it only at `markEmailSent`, so a refire that failed or ended unknown leaves the previously delivered copy intact (M-E13). |
| `sent_at` | for `sending` and `delivery_unknown`, the moment the provider call STARTED — the `since` a human needs. For `NULL`/`sent-by-cloud`, the delivery time. |

`GET /api/earnings/email-content` returns `deliveryState` beside `sentBy` so the viewer can say
which of those it is looking at: during a refire's `sending` window it is showing the PREVIOUS
email, and that is intended.

A manual refire CASes on the prior row identity (`error` + `sent_at` as the claim saw them), so
two refires racing cannot leave the loser's message id paired with the winner's body.

**Closing a `delivery_unknown` row.** Two roads, both explicit and both human-initiated:
`POST /api/earnings/email { eventId, phase, markDelivered: true }` confirms the email DID arrive
and flips the row to sent without sending anything (`sent_at` untouched, the confirmation appended
to `provider_response`); or the same route without the flag REFIRES, which is a real second email.
Nothing automatic ever resends an unknown row — not the sweep, not the nudge, not the Worker.

### Worker preview window is Mac-first

Worker `[105,120]` vs Mac `[105,135]` min-until-release, so the Mac's tick always enters the window
first. **Never set them equal** — fixed cron phases turn equal windows into a race one side loses
EVERY day (same failure family as the 6/3–6/9 digest incident).

### The window offset alone is NOT sufficient (2026-08-05, APP/MELI)

launchd `StartInterval` re-anchors to job **COMPLETION**, so one 60–180s compose slides the next Mac
tick past the Worker's fixed `:00`/`:15` grid — an awake Mac lost both 16:15 previews by 2 min.

Closed by the **Mac-aliveness marker**: every completed sweep tick fire-and-forget POSTs
`/internal/mac-recent-earnings-sweep` (`postMacRecentEarningsSweepMarker` in
`lib/cron/earnings-marker-check.ts`; Worker KV key `mac-recent-earnings-sweep`, deliberately **TIGHT
25-min TTL** — the Worker's preview window is only 15 min wide, so a stale-marker skip forfeits the
cloud's one shot; the marker must vouch for a tick that genuinely just ran). The Worker's earnings
fallback then skips PREVIEW candidates while it's fresh (skip reason `mac-recently-swept`, markerless
so an expired marker lets a later in-window tick retry).

Recaps + actuals-capture are deliberately **UN-gated** (additive, per-event markers already dedup,
time-critical post-print) — never widen the gate to them.

Recovery for a lean preview that slipped through anyway: manual re-fire (`POST /api/earnings/email`)
is allowed over a `sent-by-cloud` row and overwrites in place.

### Morning debrief supersedes the EOD wrap (2026-08-02)

Wrap-SUPPRESSION applies to **AMC clusters ONLY since 2026-08-04**. BMO clusters are **EXEMPT** — a
BMO cluster's individual recaps land the SAME morning the user is following the prints, so the
defer-to-debrief rationale never applied (the 8/04 DOCN/XMTR/WIX cluster had to be recapped
manually; the Mac suppression branch gates on `slot === "AMC"`).

An AMC recap cluster still skips individual sends as `wrap-pending`, on the same raw
`lib/earnings/wrap.ts::getExpectedRecapCluster(...).length >= WRAP_THRESHOLD` (= **3**)
determination, and `runWrapPass` is **retired** from the sweep (and was deleted with
`lib/earnings/wrap-send.ts` on 2026-10-08). Suppressed names roll into the
**7:45 ET morning debrief** (`lib/earnings/debrief-send.ts::runMorningDebrief`, gated 07:45–08:20 ET
+ once-per-day settings key `last_debrief_date`, invoked from the sweep tick **BEFORE** its
per-candidate loop — 60–180s individual sends would otherwise push the debrief past its window
close). The debrief is:

- ONE email (subject "☕ Earnings Debrief"),
- AI synthesis (feature key `earningsDebrief`, no-restating-headlines prompt) over per-name
  scoreboards + transcript desk-note guidance excerpts + user call notes,
- per-member completed recap audit rows (same dedup surface as before),
- a roster line (with ET send times) for names already recapped individually.

**Candidate window**: the unsent lookback is a self-healing `[today-3d, today]` — the Mac's `pmset`
wake fires 08:40 weekdays (AFTER the window) and never on weekends, and with the wrap retired
nothing else ever recaps a wrap-suppressed name, so a missed morning MUST self-heal. Already-sent
names are excluded by the `earnings_emails` join, so the wider window can never re-narrate.
TODAY-dated rows additionally require `enriched_at IS NOT NULL` (release-age is the wrong readiness
proxy — the individual recap that enrichment unlocks is richer); the `alreadyRecapped` roster stays
`[yesterday, today]`. A candidate-less tick does **NOT** stamp the day key (the stamp still precedes
compose on the sending path).

The debrief carries the wrap's Mac↔cloud marker dance: `checkEarningsCloudMarker` per CLAIMED member
before compose (cloud-delivered → release that claim + record the `sent-by-cloud` row via the shared
`lib/mutations/earnings-emails.ts::recordCloudSentAudit`, also used by the sweep) and
`writeMacSentEarningsMarker` per covered member after the send.

Recovery CLI for a slept-through morning: `npx tsx scripts/send-morning-debrief.ts`. Quiet-day
individual recaps unchanged.

### Worker wrap is suppress-but-never-send

*(2026-08-02 evening; AMC-only since 2026-08-04, parity with the Mac)*

The cloud staple-at-deadline email is retired too. A heavy-night AMC cluster (≥3 expected recaps; the
Worker builds its suppression cluster for the AMC slot only) suppresses its members from individual
cloud recap sends (skip reason `wrap-suppressed-for-debrief`, **no markers written**) and NOTHING
replaces them from the cloud — the names roll into the Mac's next morning debrief (the 3-day
self-heal covers a slept-through morning; there is deliberately **no cloud debrief**).

Quiet nights (< threshold) still get individual cloud recaps. The stapled-wrap SENDER
(`lib/earnings/wrap-send.ts`) and its test were deleted on 2026-10-08, after a whole-repo search
found no caller. What remains is the cluster rule only: `lib/earnings/wrap.ts` (pure:
`getExpectedRecapCluster`, `WRAP_THRESHOLD`, `SLOT_DEADLINES_ET`) and the Worker's
`SLOT_DEADLINES_ET` / `wrapSlotForCloud`, which decide suppression and are parity-pinned
(`workers/cron/test/wrap-parity.test.ts`).

---

## 8. Per-event email skip

`earnings_email_skips` (**migration 045**) mutes one (event, phase) pair without muting the symbol.

`findEmailCandidates` LEFT JOINs `earnings_emails` + `earnings_email_skips` and excludes via a NULL
check. UI: `EarningsRowChips.tsx`; route `app/api/earnings/skip/route.ts` (in-app, no cron auth).

---

## 9. Earnings source hierarchy

*(migration 068, 2026-07-17)*

Earnings preview/recap source priority lives in `research_sources.earnings_rank` (+ per-source
`earnings_note` prompt guidance) — **never a hardcoded constant**. `PREFERRED_SOURCE_IDS` was deleted
from `send-earnings-email`; the same-named constant in `lib/calendar/briefing.ts` is the SEPARATE
briefing deep-read list, deliberately untouched.

### `getNewsletterContext` (exported, `lib/digest/send-earnings-email.ts`) is a rank-ordered fill

1. One all-sources candidate query. The SQL pre-filter `ORDER BY` must stay rank-aware —
   `(earnings_rank IS NULL), earnings_rank, received_at DESC` — or a recency flood evicts ranked
   candidates before the JS sort sees them. Since 2026-07-20 (`77a8f32`) the query also carries a
   `ROW_NUMBER() PARTITION BY source_id` cap of `PER_SOURCE_FETCH_CAP = MAX_NEWSLETTER_ARTICLES × 3`
   (= **18**, sized so a 3-editions/day source still yields 6 post-supersedence articles for pass 2).
   Without it, ONE ranked source with ≥30 in-window rows consumed the whole `LIMIT 30` pool; and
   because 18 < 30 the pool's `distinctSources` is now truthful by construction.
2. Same-source same-ET-day edition supersedence (`classifyEdition`).
3. Ranked-first (rank asc, id tie-break) then unranked, recency desc within.
4. Two-pass fill under the 8k/80k caps: pass 1 caps `MAX_ARTICLES_PER_SOURCE = 2` per source (a
   prolific rank-1 daily like VK must not monopolize all 6 slots — real-data finding); pass 2 refills
   to 6 only when a single source covers the symbol.
5. 30-day backstop only on zero 7-day candidates.

Unranked sources **FILL REMAINING SLOTS** — never re-introduce the old zero-hit tier gate (one stale
preferred mention used to suppress fresh non-preferred previews).

Renderer (`renderNewslettersBlock`) emits each source's note once (first article only) + trust-order
framing + a cross-source dedup instruction in the framing text.

UI: hierarchy editor in `ManageSourcesModal` via `PATCH /api/research/sources` (`earnings_rank`
positive-int-or-null, `earnings_note` trimmed empty→NULL; the server does **not** enforce rank
uniqueness — reads tie-break by id).

Spec: `docs/superpowers/specs/2026-07-17-earnings-source-hierarchy-design.md`.

---

## 10. Read-through pairs

**Migration 044** `read_through_pairs` (`lib/queries/read-through-pairs.ts`).

- `getReadThroughReporterSymbols` — consumed by `lib/calendar/sync.ts` to merge non-held reporters
  into the Finnhub sweep so they enrich.
- `getReadThroughsForTargets` — powers the composer's `renderReadThroughsBlock`, slotted between the
  newsletters and analyst sections, sorted by weight, 14-day lookback.
- `isPlausibleEarnings` guard rejects implausible Finnhub actuals: EPS outside [0.5×, 1.7×], Rev
  outside [0.7×, 1.4×], and since 2026-07-06 **any EPS sign flip vs consensus** (GAAP/FFO basis
  mismatches like U/LAND). A genuine $0.00 actual passes as "no claim".

---

## 11. Read-through reporter recap

*(feedback #3, 2026-08-03)*

A **PURE read-through reporter** (not held/watchlist, ≥1 live pair) with FIRST ACTUALS captured gets
a lean **zero-AI** recap on the next sweep tick.

- `findEmailCandidates` third road (`EmailCandidate.reporterRecap`, `actual_value` +
  `event_date ∈ [yesterday, today]`, **NO `enriched_at` gate** — that's the ASAP point; reporter
  symbols join the status map so a held-but-audited symbol never misreads as a pure reporter) →
- `lib/earnings/reporter-recap.ts::sendReporterRecapEmail` — claim-before-compose on the reporter
  event's own `recap` slot (no migration; the audit row stores the markdown so viewer/chips work;
  `recordEarningsEmailAudit` is now exported and `aiInputHash` nullable for deterministic sends).

**Composer**: deterministic scoreboard + reaction-pending ETA + hypothesis verbatim (multi-line
blockquote-safe) + target next print (unreported rows only) + direction-only positions.

**Guards**: ANY implausible figure withholds entirely (conjunctive `isPlausibleEarnings`;
`console.warn` breadcrumb; benign `not_ready` retry until the window closes), plus a **pre-print
floor** — actuals recorded but release instant still future → withheld (the manual-typo defense the
AI road gets from its `enriched_at` gate).

**Wrap suppression exempts reporter candidates** — the debrief never covers non-held names, and the
signal is only valuable timely.

No Worker fallback in v1 (push-at-print covers cloud). Spec:
`docs/superpowers/specs/2026-08-03-reporter-recap-design.md`.

---

## 12. Push-at-print composer

The composer is **pure + Worker-mirrored**: `lib/alerts/print-push-message.ts` has **ZERO imports by
design** (its `workers/cron/src/print-push-message.ts` mirror is byte-parity below the header,
parity-tested) — never add an import there; change both files together.

**Senders**: Mac `lib/alerts/print-push.ts::sendEarningsPrintPush` (checks then writes the shared
`print-push-{eventId}` KV marker via `lib/cron/earnings-marker-check.ts`; unreachable Worker → push
allowed); Worker inline in `calendar-enrich.ts`.

**Content** is public market data **plus read-through target symbols + the user's curated hypothesis
text** (#13, 2026-07-16) — never quantities or dollar values.

**The gate** is held/watchlist **OR** ≥1 live read-through pair
(`lib/alerts/read-through-push.ts::getLiveReadThroughsForReporter` — a pair counts only while its
TARGET is currently held/watchlist, so exits self-narrow the gate; family-aware on both sides; the
Worker reads snapshot **v10 `readThroughPairs`**, ≤v9 degrades to held/watchlist-only). A
read-through-only push flags its title "— read-through". Muting the REPORTER symbol still mutes its
push.

`compactRevenuePair` (`0fb693c`, 2026-08-28) renders an actual/expected revenue pair on ONE shared
scale at the smallest precision (1–3dp) that keeps the two numbers visually distinct, plus a signed
one-decimal surprise percent — fixes a beat collapsing to equal strings at a fixed 1dp (CRWD 8/26:
$1,470.9M vs $1,468.8M both rendered "1.5B"). Worker mirror is byte-parity, parity-tested.

---

## 13. Print-sheet pipeline

*(2026-08-06/07, spec `docs/superpowers/specs/2026-08-06-earnings-print-prose-round-design.md`)*

The auto-printed worksheet is now the **email-identical** road, not the monospace re-columned one.

### Compose → PDF → print

`lib/earnings/print-sheet.ts::composePrintSheetHtml` composes the LOCAL preview's own HTML
(scoreboard → sheet-bogeys-by-source → the sent preview's bogies table lifted **byte-for-byte** from
`ai_output_md` via `extractBogiesTableMarkdown` → full user notes → past prints) through the shared
`briefingToHtml`.

`lib/earnings/print-pdf.ts::renderHtmlToPdf` shells out to headless Chrome (`--headless
--print-to-pdf`, DI spawn seam) and polls for a `%%EOF` byte marker rather than waiting on process
`close` — **headless Chrome never fires `close` on this Mac**, so a close-based wait hangs forever.
`printPdfViaLp` sends the result duplex (`lp -o sides=two-sided-long-edge`) so notes overflow lands
on the physical back of one sheet.

### One-sheet enforcement is a 3-rung ladder, capped, never loops

1. \>2 pages → drop Past prints and re-render
2. still >2 → re-render once more with `{ compact: true }` (smaller font/spacing, `COMPACT_CSS`)
3. still >2 → print anyway

Notes and the bogies table **NEVER truncate** to hit one sheet — at that extreme, complete beats
one-sheet.

### Print CSS must fight the envelope's inline styles

`briefingToHtml` (shared by every outbound email) is inline-styles-only by design and is **never
modified for print**. `PRINT_CSS`'s `@media print` block instead forces every inline
background/text color the amber/cream envelope emits to white/black with `!important` on each
declaration (inline styles otherwise win over any stylesheet). Table **BORDERS stay untouched** (the
ruled grid is what makes the sheet fillable by hand); header cells keep a light-gray tint rather than
pure white so the header row still reads.

### Failure = downgrade, never silence

Chrome missing / spawn error / 30s timeout / unparseable-or-0-byte PDF falls back to the existing
monospace sheet (`worksheet-rich.ts` → `printViaLp`), unchanged. A PDF-road `lp` failure ALSO falls
back to monospace and stamps `printed_at` on the monospace success rather than leaving the tick
stampless for retry (ruling recorded 2026-08-07 — never-silent wins over route-purity).

Manual "Print now" and `printArmedWorksheets`' wait-for-local-preview gate / stamp-retry semantics
are unchanged; a no-local-preview event still uses the unchanged deterministic one-page composer
(`composeWorksheetForEvent` in `lib/earnings/worksheet.ts`).

### Outputs are buttons (slice E, 2026-09-04)

Spec §4.5, ruling: *"The first output is the on-screen first-pass read. Paper and email are buttons
pressed afterwards, never automatic."* Nothing in this slice fires on a timer.

`lib/earnings/print-outputs.ts::evaluatePrintOutputs(db, printId)` is the single answer to "what
should the two buttons look like", and `GET /api/print-watch/status` carries it per print. The UI
never re-derives a gate, so a disabled button and a route refusal can never disagree. Its
`sendRecap.state` type is spelled `"unsent" | DeliveryStateWord` rather than five literal strings —
the display word `"sent-by-cloud"` is byte-identical to the DB sentinel and trips the state-literal
guard; the resolved value set is exactly the contract's five words, pinned at compile time by a
`Record<RecapSendState, true>` exhaustiveness check in the test.

**Post-print sheet** — `POST /api/print-watch/print-sheet { printId }`.
`lib/earnings/post-print-sheet.ts` loads the print (scoreboard rows with the delta computed in code,
accepted callouts, the newest done first-pass read, the bogeys-by-source table, the family notes),
`lib/earnings/print-sheet.ts::composePostPrintSheetHtml` lays it out, and
`lib/earnings/print-ladder.ts::printHtmlOneSheet` — the SAME 3-rung ladder the pre-print worksheet
uses, extracted in this slice — renders, counts, drops the FLEXIBLE block (here: the bogeys table),
compacts, and prints. Any PDF-road failure downgrades to a monospace sheet; only a failure of both
roads throws. Disabled with "No line has a value yet — the sheet prints once the first figure
lands." Paper is local and is never privacy-masked.

**Send recap now** — `POST /api/print-watch/send-recap { printId }`.
`lib/earnings/recap-nudge-gate.ts` refuses with domain copy until the headline pair is ACCEPTED
(the promote route's pair-completeness and promote-identity rules, re-stated — an accepted EPS line,
adjusted preferred with a GAAP fallback, and an accepted `revenue_q`, both with a reported value on
the CHOSEN line) and PROMOTED (cluster-scoped `manual_actuals_at` AND a non-null `actual_value`; a
recap without an actual is never sent). The promote-identity check normalises both sides through
`mergeFinnhubActual` — the same formatter the promote path uses — so a formatting-only rewrite (the
Worker renders revenue through `toLocaleString`, the local formatter does not) can never wedge the
button shut; if the two genuinely disagree the desk is told to promote again
(`GATE_PAIR_CHANGED`). The gate deliberately does NOT model the accept route's supersession
recheck — the route also allows `forceSuperseded`, and modelling it naively would wedge a
deliberately-forced promote's recap shut with no escape; the desk's protection there is the panel's
own "superseded — re-verify" state plus the fact that sending is an explicit button press. Every
coordination outcome is a 200 the desk reads verbatim.

**One send path.** `lib/earnings/send-service.ts::sendEarningsCandidate` is the only thing that
turns a claim into an email — the sweep loop, the nudge and `POST /api/earnings/email` all call it.
It resolves the recipient, claims, AWAITS the running marker, composes, mints the Message-ID, CASes
the row to `sending`, races the provider against `SEND_TIMEOUT_MS` (90 s), then CASes to `sent` and
awaits the mac-sent and clear markers. One caller keeps its own claims because it batches several
events into ONE email: `debrief-send.ts`. `tests/repo/one-claim-owner.test.ts` pins that list. (The
stapled-wrap sender, the other former claim owner, was deleted on 2026-10-08.)

**Failure classification.** A send is `delivery_unknown` only when the message MAY have been
transmitted: our own deadline elapsed, or nodemailer reported `ECONNECTION`/`ESOCKET`/`ETIMEDOUT`/
`ESTREAM` with `command === "DATA"`. Everything else — an explicit server refusal (`EENVELOPE`,
`EMESSAGE`, `EAUTH`, `EPROTOCOL`), a failure before DATA, or a plain `Error` with no code — is a
definitive non-delivery: the claim is released (or, for a refire, the delivered row is restored byte
for byte) and the next tick retries.

**The recap sees the read.** `lib/digest/print-watch-read-block.ts` adds a `## Print-watch read`
block to the recap prompt AND the recap body: verdict words (`DirectionSafeFacts` — the type
boundary; a `ReadFact` number cannot compile into it), the sanitised first-pass prose, and the
callouts the desk accepted. This is what closed the "recap email is blind to the print-watch sheet"
TODO.

**One lifecycle primitive.** `lib/earnings/send-service.ts::deliverClaimedBatch` implements steps
5–7 (the `sending` CAS, the single provider call, the classification, the terminal transitions and
the per-member mac-sent markers) for N already-claimed members covered by ONE email.
`sendEarningsCandidate` calls it with one member; the 07:45 ET morning debrief
(`lib/earnings/debrief-send.ts`) calls it with N. The retired stapled-wrap sender never adopted
this lifecycle and was deleted on 2026-10-08; any future batch sender must be built on
`deliverClaimedBatch`.

**An unknown ending CLAIMS the phase.** nodemailer offers no way to abort an in-flight `sendMail`:
after our 90-second deadline the call and its socket keep running, and the message may still be
delivered. So on every `delivery_unknown` path — our timeout, an ambiguous provider failure, a
post-accept persistence failure, or a row the reaper already flipped — the service writes the
mac-sent KV marker BEFORE releasing the running marker. The Worker then treats the phase as taken
and never sends a second copy. Marker writes are best-effort (fail-open); the DB flip is what
blocks a local resend.

**The cloud pre-check belongs to the service.** `checkEarningsCloudMarker` runs inside
`sendEarningsCandidate` for the AUTOMATIC modes (`sweep`, `nudge`) and not for `manual` — a human
refiring is asking for a second copy on purpose. It used to live in the sweep loop only, which left
the nudge able to duplicate a recap the Worker had already delivered; that sweep-loop copy is
deleted. The morning debrief keeps its own PER-MEMBER pre-check; that is a different question over
a batch.

---

## 14. `renderSheetBogeysBlock` — deterministic per-source bogeys table

*(2026-08-06)*

`lib/digest/send-earnings-email.ts::renderSheetBogeysBlock` renders a `## Sheet bogeys — by source`
table **code-built directly from `earnings_bogeys` rows — zero AI involvement**, per the standing
"never let the model author numbers the system already has structured" principle (same family as
`renderHeadlineTable`).

- One column per source (`source_label`, most recent first, cap 3 + a "not shown" line beyond that).
- Rows for EPS / Revenue / Expected-move plus a union of `segment_breakdown_json` rows across sources
  (malformed JSON skipped silently).
- Whisper values marked `w` and bolded.
- Rendered into **BOTH** preview and recap markdown (after Past prints, before the AI output) so it
  appears in the email AND on the printed sheet — when two curated sheets (e.g. TMT Breakout vs
  FundaAI) disagree, each source's number is visible side by side instead of the model being forced
  to merge them into one Consensus/Prior column.
- Empty bogeys list → returns `""`, unchanged emails for names without sheets.
- The prompt tells the model **NOT** to re-list this table and to cite the source label in-cell
  whenever it uses a sheet value.

### A bogey row counts only when the composer prints something from it (2026-10-08)

An all-empty bogey row is not coverage (owner ruling 2026-08-12). The second half of the 2026-10-08
sprint found the class was wider: a row can hold something a composer does not print (a segment
with no number, an extra metric line the cloud cannot see), and the email then listed an entry
with nothing under it while its footer said the bogeys were included. So the rule is about
printing, not holding.

- **Mac prompt block.** `lib/earnings/bogey-prompt-entries.ts` builds each row's printed lines
  first (`bogeyPromptEntryBody`); a row with none is not an entry. `bogeysPrintedInPrompt` is the
  one reader of "does this event have bogeys, as far as the email prompt is concerned":
  `renderBogeysBlock` renders from it and the prompt context is filtered through it, so the count
  and the rendering cannot disagree.
- **Mac sheet table.** `renderSheetBogeysBlock` is fed `sheetBogeysWithCells(...)`: a row the table
  shows no cell from is never a column. The table itself is the judge.
- **Both Mac paths start from `getBogeysWithContentForEvent`** (`lib/queries/earnings-bogeys.ts`),
  which drops empty rows by the one content rule, `bogeyHasContent`
  (`lib/mutations/earnings-bogeys.ts`).
- **`getBogeysForEvent` stays unfiltered on purpose.** The edit modal must list an empty row so the
  user can delete it. Do not add the filter there.
- **Cloud.** `workers/cron/src/bogey-content.ts` holds the Worker's two rules:
  `snapshotBogeyHasContent` (the content rule applied again on arrival, so an older snapshot cannot
  make the cloud email claim bogeys it has none of) and `snapshotBogeysPrinted` (the printing
  rule). `resolveBogeysForEvent`, `hasBogeys` and `renderBogeysBlock` in `fallback-earnings.ts`
  all go through `snapshotBogeysPrinted`.
- **The vendor EPS consensus is printed and labelled as the vendor's** ("vendor EPS consensus ...
  (basis unspecified)"), never as "EPS consensus".
- **One documented difference:** the nightly snapshot does not carry `extra_metrics_json`, so a row
  whose only content is an extra metric line is an entry on the Mac and not in the cloud.
- **Lesson:** "claims X is included" and "prints X" must come from one list. Two separate checks
  drifted the same night they were written.

Test: `tests/earnings/bogey-content-worker-parity.test.ts` (Mac suite; it loads the Worker file
directly, which is why that file has no imports).

### A recap scoreboard prints dashes; other pages keep fill-in boxes (2026-10-08)

The shared markdown renderer turns a dash or empty table cell into an empty box, so a printed page
can be filled in by hand. It did that on recaps too, where the scoreboard legend says a dash means
the figure was not available at send time. Now:

- `usesFillInBoxes(md)` in `lib/calendar/briefing-html.ts` (Mac) and `workers/cron/src/html.ts`
  (Worker) decides per page. A page is a recap when it carries a heading that ends "scoreboard —
  post-print" and no heading that ends "scoreboard — into the print". A recap prints the dash.
  Every other page (briefing, digest, evening, preview, the printed worksheet) renders exactly as
  before.
- Heading lines only: the same words in running text or in a title change nothing.
- **The renderer keys on the heading WORDING.** The headings are written by the two scoreboard
  composers (Mac `renderHeadlineTable`, Worker `renderScoreboard`). Rewording either heading means
  changing both composers and both renderers together, and deploying the Worker first.

Tests: `tests/calendar/briefing-html-tables.test.ts`, `tests/digest/earnings-intel-render.test.ts`,
`workers/cron/test/html.test.ts` (pins the two renderers together).

### Newsletter re-scans preserve, never erase (`cb4e9ef`, 2026-08-28)

`upsertBogey`'s conflict clause used to overwrite every field with the incoming extraction, nulls
included — a later newsletter issue mentioning the ticker with no numbers erased the earlier issue's
consensus in place. `preserveExisting` (newsletter re-scans only) COALESCEs content columns
(`excluded` over stored); provenance columns still take the incoming write, and advance only when the
scan actually contributed content. Manual entry and PDF upload keep full overwrite so a correction can
still clear a field.

The extraction prompt carries a KNOWN FORMATS block for the TMTB "Buyside Bogeys" shape (leading
figure = buyside whisper, "Street @" = consensus, "guide of" → `guidance_notes`); `guidance_notes` now
flows prompt → parser → upsert.

---

## 15. Notes-are-sacred across all earnings print roads

User stock notes (`getNotesForFamily`) must **never be silently truncated** on any surface that
prints them.

- The PDF print-sheet road (§13) renders every note in full at any length.
- The monospace fallback (`worksheet-rich.ts`) retired its former silent `.slice(0, 4)` note-count
  cap + `.slice(0, 74)` char truncation (no ellipsis, no marker — found live 2026-08-06) in favor of
  full-text word-wrapping, still bounded by the existing page cap.
- The deterministic no-local-preview composer (`composeWorksheetForEvent`) was **NOT** touched in
  this round and still truncates unmarked — filed as a deferred-minors TODO item, not a silent
  regression since it predates the notes-are-sacred rule.

## Print-watch v1 (2026-08-20)

Live print-time surface: when an armed earnings event prints, the bogey sheet fills on a Today panel within seconds-to-minutes, dual-parsed and reconciled, verified by the user before anything promotes. Spec: `docs/superpowers/specs/2026-08-20-live-print-watch-design.md`; plan: `docs/superpowers/plans/2026-08-20-print-watch-v1.md`.

**Trigger flow.** Arming a worksheet (the existing arm chip) also arms the print-watch. The in-process watcher (`lib/print-watch/watcher.ts`) is nudged by the earnings sweep and kept alive by the Today panel's 60-second `POST /api/print-watch/ensure`; it holds a DB lease (`settings` key `print_watch_lease`, 60s TTL) so dev `:3000` and packaged `:3099` never double-poll. Inside the EFFECTIVE window (`lib/print-watch/window.ts`: start = min(release − 10m, press − 60m), end = max(release + 45m, press + 90m, extension) — the scheduled term needs a resolved release time, the forced term exists once "Print is live" has been pressed, "Extend 30 min" stacks 30-minute extensions, and every consumer reads this one function) it polls the roads IN PARALLEL under the acquisition scheduler (`lib/print-watch/scheduler.ts`: per-host-family token buckets — SEC ≤ 2 requests/second across CIKs — concurrency caps, one coalesced pass per print) — each road wrapped in its own abort timer that cancels the socket (`runRoad()` in `lib/print-watch/watcher.ts`): DJ via the shared TWS connection (verbatim press releases stitched from multi-part articles, quiescence-gated; flash bullets into a provisional lane), EDGAR per-CIK submissions (8-K/6-K in the acceptance window, ALL EX-99.* exhibits), and the NVDA newsroom RSS (cache-busted). The drop zone (`POST /api/print-watch/drop`) is always armed and takes HTML, plain text, or PDF as a file, or a pasted `https` link (`{ eventId, url }` — validated by the SSRF contract in `lib/print-watch/ssrf.ts`, fetched by `hardenedFetchBytes` with a pinned lookup); a stored per-company IR page (`PUT /api/print-watch/sources`, `print_watch_sources`) is polled in-window with a baseline recorded at arm time in `print_watch_ir_seen` (event-keyed) by the `ir_baseline` prepare step — and ONLY before the window opens (R-C15): a press that arms the event AT the print enqueues that step too, and a baseline taken then would record tonight's release as history and blind the road for the night (durably — every runtime seeds its seen-set from that table). Once `effectiveWindow` has opened the step completes as a no-op ("window already open — no baseline possible") and the lane falls back on its strict period gate, which is what the "no baseline (armed late)" note means. The NVDA RSS config keeps precedence over a stored page. An armed symbol with NO stored IR page carries a permanently `pending` `ir_baseline` prepare row — `pending` is a precondition, not a failed attempt (it costs no attempt and becomes runnable the moment `PUT /sources` drifts the step's fingerprint), so a Hub that renders prepare rows must not show it as stuck. A TAS-slot event with no resolved release time gets no auto window — drop-zone only.

**Go action (v2 slice C).** "Print is live" (`POST /api/print-watch/go` → `lib/print-watch/go.ts::requestGo`) is a durable request: it arms the event if needed, stamps `print_watch_prints.forced_open_at` ONCE (a repeat press never widens the window — extension is the explicit control), persists a pasted file content-addressed or a pasted link stored verbatim (fragment stripped; embedded credentials or a secret-bearing query key refuse the whole press instead) BEFORE acknowledging, inserts a `print_watch_go_requests` row, and wakes the watcher. The lease owner claims the row by compare-and-set (a claim older than 60 s is stale and taken over; three attempts, then `failed`), runs the input road, then one fan-out pass; the per-road outcomes land in `result_json` and on the card. Another process's PRESS is picked up within 2 s by the lease owner's dispatcher tick — including a press for a print that owner has NEVER reconciled: when a tick finds a takeable row it cannot place, or a live forced window with no loop behind it (the Extend case), it spends ONE `ensurePrintWatch` on it and re-reads (R-C16). That memo is sticky on purpose, so work that stays unplaceable never re-sweeps every two seconds — which makes the exact promise "a press is placed within 2 s; a row that once FAILED to place waits for the next ensure (the panel's 60-second poll, or the 15-minute sweep) when what would finally make it placeable is a change the tick cannot see, such as the desk re-arming the event from the worksheet". Losing the LEASE mid-run requeues the request for the new owner instead of answering the press with three `skipped` reports for a fan-out nobody ran (R-C18). A press re-arms the event, so it also re-opens a print the desk had disarmed; conversely a DISARM after a press ends the forced watch on the next sweep — the user's disarm wins (R-C17). "Extend 30 min" is refused on a print with no window at all (an unresolved TAS row that was never pressed). TWS down at go → the wire road reports `skipped: tws offline` while EDGAR and the IR page still poll.

**Extraction.** Documents pass a doc-to-event gate (symbol/issuer + fiscal-period token; rejects stored as `rejected:<reason>`), then parse per representation (`lib/print-watch/representations.ts` + `extract.ts`, Sonnet tier via the registry) into candidates reconciled ACROSS the print's whole document set (`reconcile.ts`): agreed requires ALL non-flash value candidates unanimous plus one independent pair; any disagreement → conflict; single document → "single source — verify"; flash never greens. Bogey expected-values live in a parallel structure that never reaches a prompt.

**Promote path.** Accepting on the panel + promote writes the complete headline pair (adj-preferred EPS + revenue, atomically, inside one transaction) through `saveManualActuals` — stamping `manual_actuals_at`, opening the recap window exactly like a hand-typed override; the clear-actuals control undoes it. Partial promotion is refused (mergeFinnhubActual would hybridize with stale fields). Accept floors on the AMC/BMO slot window rather than the stored `release_time` (§5 slot floors) — a stored call-time no longer blocks an on-time accept.

**Per-line accept (`3ca73f3`, 2026-08-28).** Every line in `agreed`/`single_source`/`flash`/pending-with-value state carries an always-visible accept control (`canAcceptLine`); un-accepting a line parks it back on `pending` with its value intact instead of losing it, and the accept route now admits that pending-with-value shape (`isAcceptableLine`) — un-accept is no longer a one-way door until the next watcher poll.

**Un-accept re-derives; per-candidate accept (2026-09-03, QA fixer, user ruling 2026-09-02).** Un-accepting a line no longer parks the old figure: `clearLineAccepted` re-runs the pure reconciler over the line's own `candidates_json` in one transaction (unanimous pool → `agreed`/`single_source` with the number intact; any disagreement → `conflict` with the stale value/snippet/doc cleared and every rival visible; an EMPTY pool keeps the old pending-with-value residue so an accidental un-accept stays recoverable; `candidates_json` is never rewritten). The accept route's `accept` entries may now be `{ metric_id, doc_id, representation? }` — the named document's figure (value, value_high, snippet, source_doc_id) is locked onto the line; 400 for a doc with no candidate on that metric, a wire-flash candidate, or an ambiguous two-reading doc; 409 `superseded` (+ `forceSuperseded`) only when a strictly LATER document disagrees, so accepting the superseding document never 409s — that IS the re-verify. Conflict rows in `PrintWatchPanel` label the expander `N rival figures ▾` and render one `accept this` control per rival.

**Storage (v2, migration 089).** Documents dedupe on CONTENT — `UNIQUE(print_id, sha256)` — and roads are provenance rows in `print_watch_document_roads` (`kind` ∈ dj-release / edgar-ex99 / ir-page / user-drop / user-url). One transactional entry, `recordDelivery` (`lib/print-watch/delivery.ts`), computes the content verdict (the doc-to-event gate, `lib/print-watch/gate.ts`) and a per-road verdict (only `ir-page` is stricter); a document parses when the content is accepted AND at least one road is. Parse claims are compare-and-set on the row (`parse_claim_token`, 5-minute stale takeover). Bytes live under `resolveDbDir()/print-watch/<printId>/<sha256>.<html|txt|pdf>`; a PDF's poppler text sits beside it as `<sha256>.pdftext.txt` with `text_sha256` on the row. Candidates from a merged duplicate are archived in `print_watch_candidate_archive`, never dropped. Evidence survives calendar-event correction through the print-watch merge handler registered with slice A's event-merge registry.

**First-pass read (v2, slice D, migration 091).** After a parse lands, a 5-second per-print debounce (fast path) or the 60-second reconcile (durable path: every live parsed print whose CURRENT fingerprint has no done/generating row and is not in a backoff) runs `runFirstPassRead`. The prompt DTO is built in ONE read transaction — facts computed in code from validated sheet rows only (`buildReadFacts`: accepted, valued, not contradicted; beat / inline (±0.5%) / miss; ranges display-only; adjusted EPS shows the vendor figure as "vendor, basis unspecified" with no delta when it is the only consensus), verbatim evidence windows from eligible documents (read by content hash before the transaction), the bogey rows (numbers + guidance text; never the desk note), the event's call note, last quarter (strictly before the event date), the implied move — fingerprinted (SHA-256 of the canonical JSON, embedding prompt/schema versions and the resolved model id; the per-request nonce that delimits untrusted blocks is excluded) and generated at most once per fingerprint (`print_watch_reads`: atomic nonce, claim CAS with a fingerprint recompute, 30 s heartbeat, 150 s abortable deadline, 3-minute stale takeover, 3 attempts with a 60 s backoff; `model_drift` when the answering model differs from the fingerprinted one). The model returns cited prose only (`read` 8–10 lines, each citing fact ids / callout keys, and `call_watch` up to 3 — cites optional there, the numeral gate applies to both: a read line with no cite, an unknown cite, or a number that is nowhere on the scoreboard is dropped at storage, and the runner needs 6 surviving read lines, which is why the schema asks for 8; the number gate is the UNION of every fact and verified callout, so a mis-CITED scoreboard figure survives while a derived one — a midpoint, a sum, a calendar year — does not, and the system prompt states those numeral rules rather than leaving the model to discover them, R-D33. Call-watch lines look FORWARD and often cite nothing, so an unknown cite is stripped rather than fatal and the read finalises `done` on 0–3 survivors — with none, the section is omitted and a caveat says `no call-watch lines survived validation`; call-watch alone never fails a read, R-D36) plus callout PROPOSALS; each proposal is verified mechanically (guidance names the metric, the sheet lacks a line for it, snippet verbatim in the normalised text, value in the snippet in the same unit, label anchored within 240 characters of the snippet OR named by the guidance) and stored under the semantic key `(doc_sha256, label_norm, unit)` inside the same transaction that finalises the read (per-callout accept flips state only; regeneration upserts and supersedes stale proposals, never an accepted one). Everything stays on the Mac: the R2 snapshot and the cloud outbox are executed under canaries in `tests/print-watch/first-pass-privacy.test.ts`; the recap composer may only ever see `DirectionSafeFacts`. Failure reporting (F2/F10): `error_code` always names the CAUSE — the attempt cap is recorded as an `attempt cap reached (N/N): …` prefix on the error text and read back as `capped`, never as a code that overwrites the reason; the status DTO's `activeRead` is LIVE work only (the newest `generating` row) and a failed attempt appears under `lastAttempt` (with `capped` and the attempt total) only while it is newer than the read on display, so a terminal failure no longer freezes the block. Merge: D's handler runs BEFORE B's — donor in-flight reads are superseded, callouts re-home on the semantic key and survive a byte-twin delete through `documents.sha256`; the target's fresh read comes from the reconcile. The first AUTOMATIC read follows the desk's first ACCEPT, not the parse: facts are accepted-only, so the parse-time hook always skips a fresh print on `no_facts` — the accept route re-arms the same 5-second debounce once its transaction commits (un-accepts included; they change the fact set too), and the debounce coalesces a burst into one run (R-D21). The durable reconcile is armed from the ensure route AND self-armed by the first `scheduleFirstPassRead` a process makes, so the email sweep's headless `ensurePrintWatch` path — which never goes through a route — still gets the 60-second tick once a parse lands (M5). After a merge, a moved donor `done` read can out-rank the target's own until the reconcile lands (at most 60 seconds), because the ranking is by row, not by which event the read was generated for. Callout eligibility also requires the proposal's UNIT to agree with the guidance metric's typed unit wherever the guidance names a figure — an "ARR growth" guided in percent refuses a count proposal — while a figure-less guidance clause (unit null) types nothing and leaves the proposal eligible (R-D24). `lib/print-watch/first-pass-format.ts` (formatting + prose sanitisation, zero imports) is the ONLY `lib/print-watch` module a `"use client"` component may import besides `types`, `first-pass-types` and `reconcile`: the rest of the directory reaches node built-ins, the database or the AI SDK and pulls them into the browser bundle, which fails `next build` outright. `tests/repo/print-watch-import-boundaries.test.ts` guards both that list and the rule that no `lib/print-watch` module imports `lib/digest`.

**089 is an EXPLICIT cutover — run it BEFORE relaunching the app.** `lib/db.ts` calls `runMigrations(db)` at module load, so the packaged app (and `npm run dev`) WILL apply 089 by itself on first launch, inside the runner's transaction and WITHOUT any of the script's gates. Run it deliberately instead, from the repo root:

1. **Quit every writer** — the desktop app, any dev server, any `tsx` script, the sandbox. Confirm with `lsof data/vanguard.db` (the script refuses if anything holds the file, and treats a failure to run `lsof` as a refusal, never as "nobody").
2. **Back up and verify**: `sqlite3 data/vanguard.db "VACUUM INTO 'data/backups/pre-089-$(date +%Y%m%d-%H%M).db'"`, then `PRAGMA integrity_check` on that copy. The `--live` gate requires a `data/backups/pre-089-*.db` newer than 10 minutes that passes integrity_check and has a non-empty `schema_migrations`.
3. **Rehearse on a copy**: `REPAIR_DB_PATH=data/backups/rehearse-089.db PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx scripts/migrate-089-document-identity.ts --rehearse` (a VACUUM copy — the script refuses the live file by real path AND by (dev, ino)). Read the report: documents before→after, candidates kept + archived (must equal before), lines changed, missing bytes, unreadable contracts.
4. **Go live**: the same command with `--live` and no `REPAIR_DB_PATH`. Exit 0 = applied and recorded in `schema_migrations`; exit 1 = refused before any write; exit 2 = an invariant failed and the whole rebuild rolled back. The script also refuses while any migration numbered after 089 is pending — the runner would apply that one first, against a pre-089 schema.
5. **Only then** rebuild and relaunch the desktop app (`npm run electron:deploy`).

**Order across the v2 slices (R-C6):** merge slice B → run this cutover FROM THAT CHECKOUT, with nothing above 089 merged (step 4 refuses while any later migration is pending, and slice C's 090 or slice D's would otherwise be applied first, against a pre-089 schema) → merge slice C (090 is additive and applies itself on the next launch) → merge slice D → rebuild and relaunch.

If the app applied 089 implicitly instead, it is not a corruption — the migration is transactional and hard-gates candidate conservation and `PRAGMA foreign_key_check` — but the bytes-on-disk gate and the fresh-backup gate were skipped: check `~/Library/Logs/Vanguard Dashboard/server.log` for the `[089]` summary line (documents merged, candidates kept/archived, missing bytes) and treat any "bytes missing on disk" warning as evidence to review. To go back: quit every writer and copy the backup over `data/vanguard.db` (with its `-wal`/`-shm` removed).

**Known limits.** The PDF pair (poppler text + Claude `document` reading) is WEAK until the pre-registered holdout passes (`docs/DECISIONS.md`, 2026-09-02) — a PDF alone never greens. No OCR (image-only PDFs are refused). 8-K/A amendments not auto-ingested; corrections surface as conflicts/"superseded — re-verify", never silent flips; coverage ladder resets on server restart until the first poll; short-lived scripts that call `ensurePrintWatch` must `process.exit()`. `forced_open_at` is stamped ONCE and never cleared (spec §9 ruling 2), so a mistaken early press on a wrong-dated event pulls every later window start back to that press: the DJ and EDGAR query bounds run days wide on the real night — more filings fetched under the SEC budget and more gate-rejected evidence rows, never wrong numbers. A `runForcedPass` call that joins an already-running coalesced pass cannot cancel it — its `AbortSignal` reaches only a pass it actually starts, never one it merely joins — and the go dispatcher lives inside the watcher process holding the lease, so with no watcher running there is no dispatch until the next `ensurePrintWatch` acquires one.

**Second live run — 2026-09-02 SNOW (acquisition MISS, recovered by drop).** Two independent lane failures, both fixed the same night:

- *EDGAR acceptance time is not what the JSON says.* `data.sec.gov/submissions/CIK….json` reports `acceptanceDateTime` as the Eastern wall-clock with a bogus `Z` while a filing is FRESH (Snowflake `16:08:29Z` = 16:08 ET; Entergy nine minutes after acceptance the same way) and as true UTC after a later rebuild (Dell's 9/1 filing: JSON `20:10:14Z`, header `20260901161014`). Parsing as UTC read the 8-K as 12:08 ET, outside the 15:45–17:00 window — the lane reported "ok — 0 filings". `pollEdgar` now prefilters on BOTH readings and decides on the filing's own `-index-headers.html` `<ACCEPTANCE-DATETIME>` (always Eastern), which it was already fetching for the exhibit list. Never go back to a single `Date.parse` of the JSON value.
- *Unheld names have no contract id, so the wire is off.* `enrichSecurities` walks HELD securities only; an armed event on a name the desk does not own arrives with `ib_con_id NULL` and the panel reads "DJ: no conId — wire off" (also silencing straddle intel and the TWS reaction snapshot). The DJ lane now backfills the conId once per print through `enrichSecurities(db, [securityId])` when TWS is up (TWS down is not an attempt; retried when it returns), and the coverage note says which of the four outcomes happened.

Recovery that night: the EX-99.1 was fetched from EDGAR and posted to `POST /api/print-watch/drop` (human route: session cookie + `vgs_csrf` + `x-csrf-token` + a trusted `Origin` header); the drop parsed in 35s and all four greened lines matched the release. Still open from that run: a same-day manual add gets no preview, so the worksheet auto-print waits forever ("armed but no local preview yet"); the sheet has no line for the metric the name is actually traded on (product-revenue guidance) because contract lines derive from bogey rows.

## Armed coverage + prepare steps (v2 slice A)

Spec: `docs/superpowers/specs/2026-09-02-live-print-v2-design.md` §4.1 (rev 4); plan:
`docs/superpowers/plans/2026-09-02-live-print-v2-slice-a.md`; rulings: `docs/DECISIONS.md`
(2026-09-03 entry). Migration 088. **The premise: arming a worksheet means "I care about this
print", so it is the coverage signal** — an armed event gets what a held name's event gets, on the
Mac and in the Worker fallback, and arming starts the preparation a held name gets for free.

**Two questions, two answers.** A decision about a SPECIFIC print asks
`coveredForEvents(db, rows)` (`lib/queries/briefing-symbols.ts`): held or watchlist, family-aware
through `issuerSiblings`, **OR** the event is armed — where "armed" is cluster-aware (R11): the
event itself, or any unsuperseded earnings row sharing its `(UPPER(symbol), event_date)`, carries
an `earnings_worksheet_flags` row. Twins of one `(symbol, date)` ARE one print, and the sweep's
dedupe and the cockpit's dedupe can pick different twins — arming the row on screen must cover the
row the engine acts on. `isEventArmed` / `getArmedEventIds`
(`lib/queries/earnings-worksheet-flags.ts`) keep their exact per-event meaning; the widening lives
only in the coverage helper. A SYMBOL-level question with no event in hand (the transcript
consumers) uses `SymbolStatus`, which gained a fourth value `armed` — precedence
`held` > `watchlist` > `armed` > `neither`, horizon `[todayET(), +14 days]`.

**`armed` is display-only.** It renders as a chip on the Today Earnings Hub row, on the earnings
cockpit rows, and in the digest's today's-reporters block plus its byte-parity Worker mirror. It
must never gate an event decision. `tests/repo/symbol-status-consumers.test.ts` is the guard: it
walks `lib/`, `app/` and `scripts/` for the six helper names, and fails on (1) a call site missing
from the allowlist, (2) an allowlist entry whose call site is gone, (3) any file classified
`selection-covered` that compares a status to `"armed"`. Effects in the allowlist are
`selection-covered`, `symbol-armed`, `unchanged-push-gate`, `display`, `helper` — **the push gates
(`enrichment-runner`, `cloud-reconcile`, `read-through-push`, and the Worker's `calendar-enrich`)
are deliberately unchanged: armed does not open a push.**

**Prepare steps.** Arming enqueues one `pending` row per registered step into
`earnings_prepare_steps` (PK `(event_id, step)`), and the route kicks `runPrepareSteps` without
awaiting it (D6 — the rescan makes model calls). Durability is the sweep, not the kick: every
earnings sweep tick first reconciles missing rows for every armed, unsuperseded, not-yet-past
event and then runs everything runnable, so a crashed kick, an arm whose enqueue never landed, or
a step registered after the arm is picked up within one tick. Slice A registers four steps
(`lib/earnings/prepare-steps/`); the runner selects work `ORDER BY step`, so **run order is
alphabetical and registration order buys nothing**:

| Step | Does | Fingerprint over |
|---|---|---|
| `con_id` | Resolves the security's IBKR contract id via `enrichSecurities` when it is missing | security row id + current `ib_con_id` |
| `consensus_row` | Upserts the engine-owned `finnhub` bogey row from the event's vendor estimates | event source + the parsed vendor pair + the event's consensus columns |
| `intel` | Runs `ensureIntelForEvents` so an armed-but-unheld name has implied-move data by print time | symbol + event date + release time |
| `newsletter_rescan` | Re-reads recent research articles for THIS event through the pure per-event path | event id + symbol + window + extractor version |

Outcomes are `done`, `pending` and `failed`. **`pending` is a precondition failure, not an
attempt** — TWS being down, or intel not yet computed, costs nothing and retries next tick; only
`done` and `failed` increment `attempts`. Claiming is compare-and-set on a fresh token
(`pending`/`failed`, or a `claimed` row older than `PREPARE_CLAIM_STALE_MS`), and finalisation is
CAS on that same token, so a timed-out worker's outcome can never land on top of its successor's.
A takeover of a dead worker's claim counts the dead attempt. `PREPARE_MAX_ATTEMPTS` = 5 retires a
row — **and the cap gates takeovers too** (R14): a row stuck `claimed` by a dead process was
otherwise re-claimed every tick forever with its side effect re-invoked each time.

Every invocation is raced against `PREPARE_STEP_TIMEOUT_MS` (4 minutes, deliberately INSIDE the
5-minute stale window so the owner always finalises before any takeover). On the deadline the
runner aborts `ctx.signal` and books the row `failed`. **Step authors must check
`ctx.signal.aborted` between units of work and keep side effects idempotent upserts** — an aborted
invocation may have written before it was cut off, and the row will be retried. `signal` is an
ADDITIVE field on `PrepareStepContext` (R13); a step typing `ctx` as `{ now }` stays assignable,
which is what lets slice B register through its shim.

Two scoping notes. `runPrepareSteps(db, { eventId })` — the route's post-arm kick — runs THAT
event's rows without the date/armed gate the sweep-style pass applies; the gate belongs to the
sweep's selection, not to an explicit single-event run. And the cluster widening has a visible
consequence (R11): where an armed twin pair exists, the two consumers that do not dedupe (the wire
probe and the upcoming-reporters list) will see both rows.

Fingerprints are checked BEFORE the attempt cap, on purpose: **drift revives a spent row.** A step
that failed five ticks must come back when its inputs change (the newsletter lands, the date is
corrected) — checking the cap first would make it terminal forever. A fingerprint that throws
fails only its own row; the pass carries on.

**Newsletter scan ledger.** `earnings_bogey_scans` (PK `(event_id, article_id,
extractor_version)`, statuses `claimed | hit | no_numbers | error`) makes the rescan resumable: the
row is claimed BEFORE the model call, so a crash mid-call leaves a stale claim the next tick takes
over rather than an invisible gap, and `SCAN_MAX_ATTEMPTS` = 3 caps the cost of a crash loop per
pair. Candidates are articles from the last `RESCAN_WINDOW_DAYS` = 14 over the same corpus floor
the global scan uses, and the per-event path NEVER stamps `research_articles.bogeys_scanned_at`.
Three rulings shape the cost:

- **already-extracted pairs are skipped** (R20) — when a bogey row for this event already
  references that article (the normal case for a name that was held, so covered, and is then
  armed), the pair is banked as a `hit` with no model call;
- **bogey reads order by the article's issue date**, upload stamp as fallback (R21) — newsletter
  bogey labels already carry the issue date, so two issues of one letter are two rows; a preview
  block that shows only the first few must show the NEWEST issues. Write order stays newest-first
  so `compileContracts`' rowid-ascending rule is unaffected;
- **each pass has a soft budget** (R22) — a bounded number of model calls and a wall-clock limit,
  both strictly inside the runner's hard deadline, after which the step returns `pending` and
  resumes next tick. A hard-deadline `failed` costs an attempt and, repeated, would retire the step.

A pass also returns `pending`, never `done`, when a pair is held by another pass's LIVE claim —
swallowing it would pin the step `done` until fingerprint drift and that pair would never be
scanned. *(R20–R22 landed in the Task 11 fix round, `750c8c0`.)*

**Merge registry.** `mergeEarningsEventState(db, donorId, targetId)`
(`lib/earnings/event-merge.ts`) folds a doomed event's state into the surviving one. It is
SYNCHRONOUS, SQL-only, must run inside the caller's open transaction, and must run BEFORE the
donor `calendar_events` row is deleted (everything cascades on that delete). Built-in rules:
`earnings_worksheet_flags` (target keeps its row; a print stamp from either side survives so the
auto-pass cannot double-print), `earnings_prepare_steps` (equal fingerprints keep the more
advanced status by a `pending < failed < claimed < done` lattice; differing fingerprints reset to
`pending` so the runner re-derives against the TARGET), `earnings_bogey_scans` (terminal
precedence `hit > no_numbers > error > claimed` — a donor hit is never lost), `earnings_bogeys`
(the existing repoint, plus a collision rule where the newer row wins: content unioned
newer-then-older, provenance from the newer row only), and the email/skip audit. The audit merge
is **no-refire**: a delivered phase on either side counts as delivered for the target, live
`in_progress` claims are never touched, and **the preview plausibility gate applies here too**
(R15) — a preview whose send date could not cover the target print stays behind and dies with its
donor rather than fabricating history and blocking the genuine preview forever. Sibling slices
register their own tables through `registerEventMergeHandler`; handlers run after the built-ins,
in registration order, reached through one lazily-invoked composition root
(`lib/earnings/registry-bootstrap.ts`) so no entry point can forget one. **Four call sites:** the
user date correction, the automatic date reconciler, and BOTH delete-with-hand-back paths (R12 the
suppress-delete of a sync row, R12b the manual-row delete) — the arm must follow the print, or an
arm dies with a row whose print survives. The merge never writes the outbox itself; the CALLER
writes one row per outer transaction when the report says `changed`.

**Cloud outbox.** `cloud_outbox` `(kind, generation, payload_json, written_at, sent_at,
send_error)` is how the Worker learns anything about armed worksheets. Every mutation that changes
the armed projection — arm, disarm, manual add/edit, correction, both delete paths — appends one
`armed-events` row INSIDE its own IMMEDIATE transaction, so the row and the state it describes
commit together and the generation is allocated under the write lock. The payload is the **full
current armed list plus tombstones**, never a diff, which is what makes a dropped or replayed row
harmless. An identical projection writes nothing and reports the generation that already stands
(D10). Live entries are limited to a 14-day lookback (R23): an armed event dated before
`today − 14` drops out of the payload and is deliberately NOT tombstoned, because it is still armed
— it has only aged out, and nothing in the cloud selects an event that old. Tombstones ride for two
ET days past the event date OR 48 hours past the removal, whichever lasts longer (D7), so a removal
can never be dropped before a snapshot that omits the event exists. Every sweep tick re-derives the projection before draining (R8) — a cheap no-op when
nothing changed, and a ≤15-minute self-heal for any un-arm path that missed its write or for state
that predates the outbox. The drain sends unsent rows in generation order, stops at the first
failure (never N+1 before N), and serialises through one in-process chain. Mutating routes attempt
an immediate push, but the WHOLE wait is capped at 2 seconds (R9): the chained drain races a timer
and, when the timer wins, keeps running in the background while the request returns. Never make a
user wait on the cloud. Worker side, KV key, resolver and the post-deploy sequence:
`docs/reference/cron-and-workers.md` §15.

**Snapshot v11.** `scripts/snapshot-state-to-r2.ts` reads everything in one transaction and adds
`armedEvents` (the same projection) and `armedGeneration` (the outbox maximum observed at that
read — a WATERMARK the Worker compares a KV delta against, not a count), plus the vendor EPS on
each bogey row. `lib/earnings/armed-events-projection.ts` owns the projection so both the script
and the mutations build the identical shape; `ARMED_EVENT_PROJECTION_KEYS` is parity-pinned
against the Worker's `ARMED_EVENT_ENTRY_KEYS`.

## Extra metric lines and recompilation (v2 slice F)

`earnings_bogeys.extra_metrics_json` holds the desk's own metric definitions:
`[{ id: <uuid v4, immutable>, label, definition, unit: usd|per_share|pct|count,
kind: point|range, period: Q|NQ_guide|FY_guide, basis: gaap|non_gaap|na,
consensus?, whisper? }]`. `lib/print-watch/extra-metrics.ts` parses them strictly
(unknown keys rejected, label ≤ 60, definition ≤ 300) and is CLIENT-SAFE, so the
bogeys modal validates with the same code the route validates with. A `usd`
figure requires at least one real digit in its comma-stripped mantissa — a
digit-free string (`","`, `"$,,,"`, `",.5"`) is a parse ERROR, never a silent
`$0`, because `$0` on this surface is a wrong number presented as a
measurement, not a small one.

`compileContracts` emits one line per merged id, `metric_id = x_<uuid>_<period>`,
`pct` mapped to the contract unit `percent`. **The same id on two bogey sheets
must agree on unit, kind, period and basis**; when it does not, NEITHER compiles
and the id comes back in the additive `conflicts` key, which
`GET /api/earnings/bogeys` republishes as `extraMetricConflicts` and the modal
renders as a banner. Numbers merge first-non-null by bogey rowid.

`recompileContracts(db, printId)` (`lib/print-watch/recompile.ts`) is explicit and
runs in ONE immediate transaction; `POST` and `DELETE /api/earnings/bogeys` call
it for the event's live print (any state but `expired`/`disarmed`) — the two
direct `upsertBogey` callers (the bogeys-upload route and the `consensus_row`
prepare step) do NOT recompile, which is benign because an extra metric only
ever originates from the modal, and the watcher self-heals `expected` on the
next parse. Per existing line: same semantics → update `contract_json`/
`expected_json` in place; semantic change (unit / kind / basis / period) WITH
evidence (`value IS NOT NULL`, a non-empty `candidates_json`, or
`state = 'accepted'`) → the old row is RENAMED to `<metric_id>~retired~<n>` and
booked `retired`, and a fresh `pending` line is inserted; semantic change
without evidence → overwritten in place; no longer compiled → retired if it has
evidence, else deleted; newly compiled → inserted `pending`. The rename is
forced by the `(print_id, metric_id)` primary key. **The rename also re-tags
every candidate inside the retired row's own `candidates_json` to the renamed
id** (`retagCandidatePool`) — `collectCandidates` walks the whole sheet with no
state filter, so without the re-tag a later document agreeing with the OLD
reading would turn the fresh line green under a definition it was never
measured against. It is safe because `upsertLines` never deletes and never
touches a `metric_id` absent from its input, and `~retired~` ids are never
compiled — so no later parse can resurrect or clobber one. `retractDocument`
already treats `retired` like `accepted`; `sheetLineKeys` reads COMPILED
contracts (so a retired line never suppresses a callout) and
`isContradictedAccepted` short-circuits on any state that is not `accepted`.

**Known gap, not slice F's to fix.** `app/api/print-watch/accept/route.ts`'s
per-candidate branch keys its guard on `metric_id === line.metric_id`, which
now matches a retired row's re-tagged pool — so a candidate that predates the
retirement can be accepted onto it after the fact, flipping its `state` to
`accepted` and rendering it as a normal, permanently-verified line (recompile
never revisits an `accepted` row). There is no UI path to it (a retired row
renders collapsed with no accept control) and it cannot reach promote or any
outbound send. The route is outside slice F's edit list; the fix has to gate
on the `~retired~` id substring rather than on `state`, because `state` is what
the bug flips.

## An armed row after its print: the read-only record (2026-10-08)

**Why it was empty.** `getWatchStatus` (`lib/print-watch/watcher.ts`) lists active prints and the
prints that expired TODAY, and nothing older. That feed also drives the poll interval, the live
countdown and the ensure route's count, so it is not widened. An armed Hub row expanded the morning
after its print therefore had no print to show.

**The scoped read.** `getPrintRecord(db, eventId)` (`lib/earnings/print-record.ts`) returns one
event's print in whatever state it is in, its sheet lines, a map from document id to document kind,
and the same output-button evaluation the status route sends. It only reads. It sits beside
`print-outputs.ts`, not under `lib/print-watch/`, because it reads the send audit through
`lib/digest` and no print-watch module may import that tree
(`tests/repo/print-watch-import-boundaries.test.ts`). Route: `GET /api/print-watch/record?eventId=`
(see `docs/reference/api-patterns.md`).

**What the row shows.** `slotBodyKind` (`app/dashboard/today/live-print/helpers.ts`) picks the
record when the row is armed, has no live print, and its event date is before today (Eastern). A
finished print dated today still arrives through the live feed. `PrintRecordView` in
`LivePrintRow.tsx` renders a window-closed header, the lines the desk accepted plus the lines two
independent readings agreed on (`recordLines`; each says in words whether it was accepted or only
agreed), each figure's source document, and the output buttons. Accepting and promoting are closed:
the promote control is permanently disabled with the reason in its title. An event with no print
says nothing was captured.

Tests: `tests/print-watch/print-record.test.ts`, `tests/api/print-watch-record.test.ts`,
`tests/dashboard/live-print-record.test.ts`, `tests/dashboard/earnings-hub-live.test.ts`.

## Transcripts: fiscal keys and the stated-quarter guard (2026-10-07)

The same-day transcript step requests the print's FISCAL quarter and caches a vendor call only when the call itself states that quarter; a filing is matched to its print by filing date. Detail and the full rules: `docs/reference/data-integrity.md` §13b.

**Vendor daily limit (2026-10-07).** The transcript vendor's free tier allows a fixed number of requests a day (`ALPHA_VANTAGE_DAILY_REQUEST_LIMIT`, `lib/transcripts/fetch.ts`). The count lives in the `settings` table under a key made of the vendor and the Eastern date (`todayET()`), so it starts at zero each Eastern day. It is bumped BEFORE each vendor call, so a failed call still counts. At the limit no vendor call is made that day; filing lookups are unchanged. Test: `tests/transcripts/fetch-quota-u13.test.ts`.

