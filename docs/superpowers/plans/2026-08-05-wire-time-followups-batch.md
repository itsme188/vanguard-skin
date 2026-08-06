# Wire-time follow-ups batch + short-chip cosmetic (2026-08-05)

Source: TODO "Wire-time follow-ups (final-review parked minors, 2026-08-04)" items (a)–(f), all triaged non-merge-blocking by the 8/04 whole-branch review, plus the "Negative holding periods: display as short" cosmetic item (2026-08-03). All fixes are prescribed; none change macro-event behavior.

## Global Constraints

- TDD: write the failing test first, watch it fail, then fix. Every task lists its test surface.
- Macro calendar rows are untouched by every wire-time change — earnings rows only (`source='finnhub'` OR `event_type='earnings'`, or symbol-bearing where stated). Never add gates to macro paths.
- `security_type` comparisons are case-insensitive (`.toLowerCase()`); symbol comparisons on user-visible surfaces go through `issuerSiblings()` (`lib/securities/issuer-family.ts`) + uppercase, never string-equal.
- SQLite timestamp comparisons wrap BOTH sides in `datetime()`.
- Colored pills/badges use the shared `<Chip>` component (`app/dashboard/components/Chip.tsx`) — never inline `bg-{color}/10 text-{color}`.
- The bubble-upstream-failures convention: a data-fetch failure must be distinguishable from "source legitimately has no data" — never a bare `catch { return null }` that conflates them.
- Wire-time architecture context: `lib/earnings/wire-times.ts::resolveEarningsReleaseTime` is the release-time resolution cascade (explicit event_time → user override → web_verified → derived from bounded observations → legacy `SYMBOL_RELEASE_TIMES_ET` → BMO/AMC defaults). `calendar_events.wire_probe_empty_at` stamps empty pre-release probes and BOUNDS observations — losing it degrades honestly but silently to unbounded.
- Run the task's test file(s) after each change; the controller runs the full suite + tsc at the end.

## Task 1 — Finnhub actuals fetch: restore error visibility on the non-probe path

`lib/calendar/enrich-actuals.ts::fetchFinnhubActual` gained a shared helper during the 8/04 wire-time build whose try/catch swallows network/JSON errors, so a Finnhub outage now reads as "legitimately empty" on the ACTUALS road (behaviorally absorbed by earnings retry-until-complete, but the loud error reason is lost — contradicting the bubble-upstream-failures convention).

Fix:
- The shared fetch helper must distinguish `{ ok: true, data: null }` (Finnhub answered, no actuals yet) from a thrown/failed fetch.
- Non-probe (actuals) path: restore pre-8/04 behavior — the error propagates (or is logged loudly with the reason and surfaced as a failure, matching whatever the pre-refactor call site did; check `git log -p` on the file for the pre-refactor shape).
- Probe path (`runEnrichment`'s T−90m pre-release probe): a FAILED fetch must NOT stamp `calendar_events.wire_probe_empty_at` — an error is not an empty probe, and stamping it would incorrectly bound wire-time observations. Verify current behavior; if it already skips the stamp on error, pin that with a test; if not, fix it.

Tests: `tests/calendar/` (find the existing enrich-actuals / wire-probe test file and extend): (1) network error on the actuals road surfaces as an error, not empty; (2) network error on the probe road does not stamp `wire_probe_empty_at`; (3) genuine empty probe still stamps.

## Task 2 — verify-earnings-dates: family-aware, case-insensitive exact-time verdict matching

`lib/calendar/verify-earnings-dates.ts`: the date/slot verdict-application loop is family-aware (issuerSiblings), but the EXACT-TIME verdict matching added by the wire-time build matches exact symbol, case-sensitively. Fold `issuerSiblings()` + uppercase normalization into the exact-time matching so a GOOG verdict applies to a GOOGL row exactly like date/slot verdicts do.

Tests: extend the existing verify-earnings-dates test file: an exact-time verdict for one share class applies to the sibling class's event row; a lowercase symbol in the model verdict still matches.

## Task 3 — confirm-earnings-date: route through the release-time cascade

`lib/mutations/confirm-earnings-date.ts` keeps a local bmo/amc → "08:00"/"16:15" mapper that bypasses the wire-time cascade when a conflict is confirmed. Replace the local mapper with `resolveEarningsReleaseTime` (lib/earnings/wire-times.ts) so a confirmed conflict row gets the same resolved release_time (user override, web_verified, observations…) every other road gets. Keep the BMO/AMC slot the user confirmed as the cascade input; the cascade's defaults already produce 08:00/16:15 when nothing better exists, so behavior is unchanged for symbols with no wire history.

Tests: extend the confirm-earnings-date test file: confirming a conflict for a symbol with a standing user override yields the override's time, not 08:00/16:15; a symbol with no wire data still gets the default.

## Task 4 — Conflict popover gains the "Reports at" editor

`app/dashboard/today/EarningsDateChip.tsx`: the passive-status ("Date is wrong?") popover has the "Reports at" wire-time editor (loadReleaseTime/saveReleaseTime already in the component); the CONFLICT popover does not. Render the same editor block in the conflict popover, reusing the existing state + handlers — no new fetch logic. Keep the conflict flow (pick Nasdaq/Finnhub/own date) unchanged and visually primary; the editor sits below it, same as the passive popover's layout.

Tests: this is a client component — extend whatever component/unit test exists for EarningsDateChip if present; otherwise verify via `npx tsc --noEmit` and a targeted render test only if the file already has one (do not introduce a new testing framework). State in the report how it was verified.

## Task 5 — Sync-side wire-time protections (items e + f)

Two related guards in the calendar sync path:

(e) `lib/calendar/sync.ts` / `lib/mutations/calendar.ts` upsert: the conflict clause COALESCEs `release_time`, which can clobber a PROBE-PULLED (earlier) `release_time` on an existing event back to the cascade output when a sync re-upserts the row (≤15-min drift, within bar tolerance — but the probe's earlier time is strictly better information). Make the upsert preserve an existing release_time that is EARLIER than the incoming one for earnings rows (the probe only ever pulls times earlier; macro rows keep exact current semantics).

(f) `lib/mutations/calendar.ts::deleteUnenrichedEventsForWeek` deletes rows whose four enrichment columns are all NULL — but does not treat `wire_probe_empty_at` as protective state, so a mid-window manual refresh drops the bounding stamp (degrades honestly to unbounded, but loses real observations). Add `wire_probe_empty_at IS NULL` to the deletable predicate (a stamped row survives sync cleanup, same as enriched rows).

Tests: extend `tests/calendar/sync-preserves-enrichment.test.ts` (or its nearest sibling): (e) a re-sync does not overwrite an earlier earnings release_time with a later one, and DOES still fill a NULL; macro rows unchanged; (f) a row with only `wire_probe_empty_at` set survives `deleteUnenrichedEventsForWeek`.

## Task 6 — Negative holding periods render a "short" chip

Lot-breakdown UI (Security Detail closed-lots table — find the surface rendering `holding_period_days`, likely `app/dashboard/security/[id]/` components) still renders "-1d" for genuine short round-trips. When acquisition date > sale date (equivalently `holding_period_days < 0`), render a `<Chip tone="info" size="xs">short</Chip>` (uppercase per Chip conventions if the surrounding table uses it) instead of the negative "-Nd" text. The underlying pairing is 1099-B-consistent — data untouched, display only. Check for a second surface rendering the same field (cross-account or tax-lots view) and apply consistently; list every surface touched in the report.

Tests: if the surface is a server component reading query output, a render-level test may not exist — verify via tsc + state in the report which surfaces were changed and how verified. If a formatter helper is introduced (e.g. `formatHoldingPeriod`), unit-test it: negative → "short", positive → "Nd".
