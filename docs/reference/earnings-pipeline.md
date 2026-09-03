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

- **COMPLETE** = actual captured AND (reaction captured OR release ≥150 min ago).
- `enriched_at` stamps **ONLY** on completion, which is what opens the recap `[enriched_at, +4h]`
  window — so recaps go out after the call, and a blocked row (`enriched_at` NULL) is reopened by a
  manual `POST /api/earnings/actuals`.
- Macro rows keep single-shot semantics exactly.

### Reaction-capture gate

Reaction capture is gated to **≥T+115m for earnings rows only** (`REACTION_READY_MS`, 2026-07-06):
bars target `t_post = release + 120m`, so earlier attempts were guaranteed-empty TWS/Yahoo rounds per
retry tick. Macro rows are **NEVER** gated — their immediate partial capture is by design.

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

### `earnings_emails.error` is a tri-state, NOT a failure flag

| Value | Meaning |
| --- | --- |
| `'in_progress'` | live claim |
| `'sent-by-cloud'` | Worker delivered (`ai_output_md` NULL — viewer shows "no local copy") |
| `NULL` | completed local send |

The `'in_progress'` claim: the `UNIQUE(event_id, phase)` row doubles as a **cross-process mutex** —
claimed BEFORE compose in `sendEarningsEmail`, released on failure so retries survive, with 30-min
stale takeover/reap. Since **migration 063** claims carry a `claim_token` UUID and release is
token-conditional, so a late finisher can't delete a successor's takeover claim — the reap is
deliberately un-tokened.

Every new reader must exclude `'in_progress'` (pattern: `getSentPhasesForEvents` / `getEmailAudit`).

Benign 409s (`EarningsEmailError.code` = `claim_held` / `not_ready`) land in `SweepSummary.skipped`
with `ok:true` — **never count them as failures** — and `alertBlockedRecaps` respects the
muted-symbols setting (no stamp on a muted skip, so unmuting re-arms).

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
determination, and `runWrapPass` is **retired** from the sweep. Suppressed names roll into the
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

Quiet nights (< threshold) still get individual cloud recaps. `wrap-send.ts` + the Worker's
`SLOT_DEADLINES_ET` / `wrapSlotForCloud` stay **retired-not-deleted** for the wrap-parity pin.

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

**Trigger flow.** Arming a worksheet (the existing arm chip) also arms the print-watch. The in-process watcher (`lib/print-watch/watcher.ts`) is nudged by the earnings sweep and kept alive by the Today panel's 60-second `POST /api/print-watch/ensure`; it holds a DB lease (`settings` key `print_watch_lease`, 60s TTL) so dev `:3000` and packaged `:3099` never double-poll. Inside [release−10m, release+45m] it polls: DJ via the shared TWS connection (verbatim press releases stitched from multi-part articles, quiescence-gated; flash bullets into a provisional lane), EDGAR per-CIK submissions (8-K/6-K in the acceptance window, ALL EX-99.* exhibits), and the NVDA newsroom RSS (cache-busted). The drop zone (`POST /api/print-watch/drop`) is always armed and takes HTML, plain text, or PDF as a file, or a pasted `https` link (`{ eventId, url }` — validated by the SSRF contract in `lib/print-watch/ssrf.ts`, fetched by `hardenedFetchBytes` with a pinned lookup); a stored per-company IR page (`PUT /api/print-watch/sources`, `print_watch_sources`) is polled in-window with a baseline recorded at arm time in `print_watch_ir_seen` (event-keyed) by the `ir_baseline` prepare step. The NVDA RSS config keeps precedence over a stored page. An armed symbol with NO stored IR page carries a permanently `pending` `ir_baseline` prepare row — `pending` is a precondition, not a failed attempt (it costs no attempt and becomes runnable the moment `PUT /sources` drifts the step's fingerprint), so a Hub that renders prepare rows must not show it as stuck. A TAS-slot event with no resolved release time gets no auto window — drop-zone only.

**Extraction.** Documents pass a doc-to-event gate (symbol/issuer + fiscal-period token; rejects stored as `rejected:<reason>`), then parse per representation (`lib/print-watch/representations.ts` + `extract.ts`, Sonnet tier via the registry) into candidates reconciled ACROSS the print's whole document set (`reconcile.ts`): agreed requires ALL non-flash value candidates unanimous plus one independent pair; any disagreement → conflict; single document → "single source — verify"; flash never greens. Bogey expected-values live in a parallel structure that never reaches a prompt.

**Promote path.** Accepting on the panel + promote writes the complete headline pair (adj-preferred EPS + revenue, atomically, inside one transaction) through `saveManualActuals` — stamping `manual_actuals_at`, opening the recap window exactly like a hand-typed override; the clear-actuals control undoes it. Partial promotion is refused (mergeFinnhubActual would hybridize with stale fields). Accept floors on the AMC/BMO slot window rather than the stored `release_time` (§5 slot floors) — a stored call-time no longer blocks an on-time accept.

**Per-line accept (`3ca73f3`, 2026-08-28).** Every line in `agreed`/`single_source`/`flash`/pending-with-value state carries an always-visible accept control (`canAcceptLine`); un-accepting a line parks it back on `pending` with its value intact instead of losing it, and the accept route now admits that pending-with-value shape (`isAcceptableLine`) — un-accept is no longer a one-way door until the next watcher poll.

**Un-accept re-derives; per-candidate accept (2026-09-03, QA fixer, user ruling 2026-09-02).** Un-accepting a line no longer parks the old figure: `clearLineAccepted` re-runs the pure reconciler over the line's own `candidates_json` in one transaction (unanimous pool → `agreed`/`single_source` with the number intact; any disagreement → `conflict` with the stale value/snippet/doc cleared and every rival visible; an EMPTY pool keeps the old pending-with-value residue so an accidental un-accept stays recoverable; `candidates_json` is never rewritten). The accept route's `accept` entries may now be `{ metric_id, doc_id, representation? }` — the named document's figure (value, value_high, snippet, source_doc_id) is locked onto the line; 400 for a doc with no candidate on that metric, a wire-flash candidate, or an ambiguous two-reading doc; 409 `superseded` (+ `forceSuperseded`) only when a strictly LATER document disagrees, so accepting the superseding document never 409s — that IS the re-verify. Conflict rows in `PrintWatchPanel` label the expander `N rival figures ▾` and render one `accept this` control per rival.

**Storage (v2, migration 089).** Documents dedupe on CONTENT — `UNIQUE(print_id, sha256)` — and roads are provenance rows in `print_watch_document_roads` (`kind` ∈ dj-release / edgar-ex99 / ir-page / user-drop / user-url). One transactional entry, `recordDelivery` (`lib/print-watch/delivery.ts`), computes the content verdict (the doc-to-event gate, `lib/print-watch/gate.ts`) and a per-road verdict (only `ir-page` is stricter); a document parses when the content is accepted AND at least one road is. Parse claims are compare-and-set on the row (`parse_claim_token`, 5-minute stale takeover). Bytes live under `resolveDbDir()/print-watch/<printId>/<sha256>.<html|txt|pdf>`; a PDF's poppler text sits beside it as `<sha256>.pdftext.txt` with `text_sha256` on the row. Candidates from a merged duplicate are archived in `print_watch_candidate_archive`, never dropped. Evidence survives calendar-event correction through the print-watch merge handler registered with slice A's event-merge registry.

**089 is an EXPLICIT cutover — run it BEFORE relaunching the app.** `lib/db.ts` calls `runMigrations(db)` at module load, so the packaged app (and `npm run dev`) WILL apply 089 by itself on first launch, inside the runner's transaction and WITHOUT any of the script's gates. Run it deliberately instead, from the repo root:

1. **Quit every writer** — the desktop app, any dev server, any `tsx` script, the sandbox. Confirm with `lsof data/vanguard.db` (the script refuses if anything holds the file, and treats a failure to run `lsof` as a refusal, never as "nobody").
2. **Back up and verify**: `sqlite3 data/vanguard.db "VACUUM INTO 'data/backups/pre-089-$(date +%Y%m%d-%H%M).db'"`, then `PRAGMA integrity_check` on that copy. The `--live` gate requires a `data/backups/pre-089-*.db` newer than 10 minutes that passes integrity_check and has a non-empty `schema_migrations`.
3. **Rehearse on a copy**: `REPAIR_DB_PATH=data/backups/rehearse-089.db PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx scripts/migrate-089-document-identity.ts --rehearse` (a VACUUM copy — the script refuses the live file by real path AND by (dev, ino)). Read the report: documents before→after, candidates kept + archived (must equal before), lines changed, missing bytes, unreadable contracts.
4. **Go live**: the same command with `--live` and no `REPAIR_DB_PATH`. Exit 0 = applied and recorded in `schema_migrations`; exit 1 = refused before any write; exit 2 = an invariant failed and the whole rebuild rolled back. The script also refuses while any migration numbered after 089 is pending — the runner would apply that one first, against a pre-089 schema.
5. **Only then** rebuild and relaunch the desktop app (`npm run electron:deploy`).

If the app applied 089 implicitly instead, it is not a corruption — the migration is transactional and hard-gates candidate conservation and `PRAGMA foreign_key_check` — but the bytes-on-disk gate and the fresh-backup gate were skipped: check `~/Library/Logs/Vanguard Dashboard/server.log` for the `[089]` summary line (documents merged, candidates kept/archived, missing bytes) and treat any "bytes missing on disk" warning as evidence to review. To go back: quit every writer and copy the backup over `data/vanguard.db` (with its `-wal`/`-shm` removed).

**Known limits.** The PDF pair (poppler text + Claude `document` reading) is WEAK until the pre-registered holdout passes (`docs/DECISIONS.md`, 2026-09-02) — a PDF alone never greens. No OCR (image-only PDFs are refused). 8-K/A amendments not auto-ingested; corrections surface as conflicts/"superseded — re-verify", never silent flips; coverage ladder resets on server restart until the first poll; short-lived scripts that call `ensurePrintWatch` must `process.exit()`.

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
