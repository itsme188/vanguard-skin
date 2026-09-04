# Live Print v2 — Slice F Implementation Plan (Today layout, Hub live controller, in-place expansion, extra metric lines)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Today becomes one earnings surface — the Alerts / Nearby-Levels / Significant-Moves / Momentum blocks leave, the cockpit and the print panel disappear as separate cards, and the week-ahead Earnings Hub grows stage chips and an in-place live-print expansion driven by ONE client controller whose polling follows the print state; plus the desk can define its own metric lines per bogey sheet and have them compiled, conflict-checked and recompiled with evidence preserved.

**Architecture:** `EarningsHub` stays a server component (it keeps its `db` reads and adds one: the cockpit payload for the Hub's whole week) and wraps its server-rendered day blocks in `EarningsHubLive` — a `"use client"` context provider that owns every poll the cockpit and the print panel own today (print-watch status hot/cool, the 60-second `/ensure`, the cockpit intel refresh, the worksheet prepare read) through a pure, React-free `createPollController` with per-stream generation counters and abort-on-hidden. Each server row is followed by a `LivePrintSlot` client leaf that reads that controller, decides expansion through a pure transition-based `deriveExpansion`, and renders `LivePrintRow` — the print header, the go controls plus the new paste box, the IR-page field, the prepare status, the road outcomes, the moved sheet and line rows, the first-pass read and the output buttons. In parallel, `lib/print-watch/extra-metrics.ts` (pure, client-safe) parses and merges the desk's `extra_metrics_json` specs, `compileContracts` emits one `x_<uuid>_<period>` line per merged id and returns the conflicting ids additively, and `recompileContracts(db, printId)` re-derives a live print's sheet inside one immediate transaction — updating, retiring-with-a-rename, or deleting each existing line according to whether it still compiles and whether it carries evidence.

**Tech Stack:** TypeScript / Next.js 16 App Router (React Server Components: a client provider wrapping server children), React 19 client components, better-sqlite3 (DI `db` first, `.immediate()` transactions), Tailwind CSS 4 tokens, Vitest (in-memory SQLite through the real migration runner; fake timers; `react-dom/server` `renderToStaticMarkup` for render assertions — React Testing Library and jsdom are NOT dependencies and none may be added).

**Spec:** `docs/superpowers/specs/2026-09-02-live-print-v2-design.md` — **§4.6 and §4.7 are this slice**; §2 rulings ("Today: Alerts and Nearby Levels leave the page. Significant Moves and Momentum Pulse move to Analysis. The Earnings Cockpit folds into the Earnings Hub rows as chips. The print-watch card becomes the armed Hub row's in-place expansion. Portfolio snapshot shrinks to one line. Week Ahead, Releases, IBKR today, and the chat button stay."), §4.3 (slice C — the go route the paste box posts to), §4.4 (slice D — the read and callouts the expansion renders), §5 ("**F**: none" — F ADDS NO MIGRATION), §6 routes, §8 F-line tests, §10 slices table (F owns `app/dashboard/today/*`, `app/dashboard/analysis/*`, `lib/print-watch/contracts.ts`).

**Cross-slice contract (BINDING):** `docs/superpowers/plans/2026-09-04-live-print-v2-outputs-contract.md`. Slice E is planned and built in parallel from the same contract. **E and F share NO file.** Every shape F consumes from E is quoted verbatim in the Global Constraints below; F renders those shapes defensively so that on F's own branch — where E is unmerged and the fields are absent — nothing breaks and nothing is claimed.

**Worktree:** sibling `../vanguard-skin-print-v2-f` on branch `print-v2-slice-f`, branched from `main` at `31d0e84f` (slices A, B, C and D are MERGED; the database is at migration 091). Slice E builds in parallel in its own sibling worktree from the same base. **Either slice may merge first; the second rebases.** F adds no migration, so there is no cutover and no migration rehearsal in this slice. Sandbox E2E runs on port **3094** (slice E uses 3095).

## Wave plan

One owner per file at a time. Every wave that adds or moves a `"use client"` file ENDS with `npm run build` — a client file that imports a server-only module does not fail a test, it fails `next build` outright (R-D20).

| Wave | Tasks | Files claimed (NEW claims from the Codex round 1 fold in **bold**) | Ends with |
|---|---|---|---|
| W1 | 1, 5, 6 | `lib/print-watch/extra-metrics.ts`, `tests/repo/print-watch-import-boundaries.test.ts` · `lib/queries/earnings-cockpit.ts`, `app/api/earnings/cockpit/route.ts`, **`lib/queries/earnings-intel.ts`** · `app/dashboard/today/hub-live/{poll-controller,expansion,types}.ts`, **`tests/repo/hub-live-client-boundary.test.ts`** | `npx vitest run` on the four test paths |
| W2 | 2, 7, 8 | `lib/print-watch/contracts.ts` · `app/dashboard/today/hub-live/send-state-chips.tsx`, `app/dashboard/today/EarningsRowChips.tsx` · `app/dashboard/today/live-print/*`, `app/dashboard/today/LivePrintRow.tsx`, `tests/dashboard/print-watch-panel.test.ts`, **`app/api/print-watch/sources/route.ts`**, **`tests/api/print-watch-sources-get.test.ts`** | `npm run build` |
| W3 | 3, 9 | `lib/print-watch/recompile.ts`, **`lib/print-watch/watcher.ts` (`writeLines` only)** · `app/dashboard/today/EarningsHubLive.tsx`, `app/dashboard/today/EarningsHub.tsx`, `app/dashboard/today/EarningsRowChips.tsx` | `npm run build` |
| W4 | 4, 10 | `lib/mutations/earnings-bogeys.ts`, **`lib/queries/earnings-bogeys.ts`**, `app/api/earnings/bogeys/route.ts`, `app/dashboard/today/BogeysEditModal.tsx`, `tests/repo/bogey-content-lists-agree.test.ts` · `app/dashboard/today/page.tsx`, `app/dashboard/analysis/page.tsx`, `app/dashboard/components/SignificantMovesCard.tsx` (moved), DELETES `EarningsCockpit.tsx` + `PrintWatchPanel.tsx` | `npm run build` |
| W5 | 11 | docs, `CLAUDE.md`, evidence | full suite + build + E2E |

**One owner per file per wave still holds after the fold — checked file by file.** The four new claims land in four different waves and none of them is claimed by any other task in the same wave: `lib/queries/earnings-intel.ts` (T5, W1) is read by nobody else in W1; `app/api/print-watch/sources/route.ts` (T8, W2) is touched by no other task in the plan; `lib/print-watch/watcher.ts` (T3, W3) is claimed by T3 alone and T9's files are all under `app/dashboard/today/`; `lib/queries/earnings-bogeys.ts` (T4, W4) is not touched by T10, and Task 2's `contracts.ts` reads `earnings_bogeys` through its OWN SQL, never through that query module, so the W2 owner and the W4 owner never meet.

Second-touch files across waves (never inside one wave): `lib/print-watch/contracts.ts` = T2 (W2) then read-only by T3 (W3); `EarningsRowChips.tsx` = T7 (W2) then T9 (W3). `app/api/earnings/bogeys/route.ts` has exactly ONE owner (T4) — the recompile trigger is wired through `lib/mutations/earnings-bogeys.ts` there, not in T3, so the route is never edited twice.

**Expected churn, not dead code (F-S11).** Task 7 gives `EarningsRowChips` an optional `cockpitRow` PROP; Task 9 replaces that prop with `useHubLive()` context in the next wave. Both are correct at their own wave boundary and the file has one owner in each — a Task 7 reviewer should not flag the prop as unused.

## Codex round 1 (2026-09-04) — disposition

18 Codex findings (verdict REVISE) plus 11 findings from the session controller's own review (cited `F-S1` … `F-S11`). The controller's rulings (session scratchpad `rulings-f.md`) are BINDING. Every ruling is folded into the task it names through an **Amendments (Codex round 1)** block placed under that task's Interfaces block; each block REPLACES the code or step it names. One finding is PARTIAL (the rest is recorded below for the user) and one needs no change in F because the cross-slice contract already resolved it.

**Counts: 27 folded · 1 partial · 1 no-change.**

| # | Finding (short) | Task(s) | Disposition |
|---|---|---|---|
| 1 | existing extra metrics cannot be edited or reconciled (GET omits them) | 4 | folded — `lib/queries/earnings-bogeys.ts` (ownership extended, additive) returns `extra_metrics_json` from BOTH SELECTs; GET republishes `extraMetrics` + `extraMetricErrors` per row; the modal hydrates the matching sheet's specs with their stored ids, shows each id read-only with a `copy id` button, and takes a pasted id at add-row time |
| 2 | id immutability is only cosmetic | 4 | **PARTIAL (R-F2, recorded)** — folded: uuid-v4 + within-row uniqueness server-side, and the add/remove protocol is stated and TESTED (dropping id A while adding id B retires A's evidenced line and compiles B). NOT folded: a separate create/retire/revise operations API and a persisted-id diff (YAGNI — "immutable" means the UI never edits an id, and add+remove already loses no evidence) |
| 3 | `Number(raw)` invents values; every unit through `parseLargeUSD` | 1, 4 | folded — unit-aware strict parsing in `extra-metrics.ts` (`usd` = the `parseLargeUSD` grammar; `per_share`/`count` = `^-?\d+(\.\d+)?$`; `pct` the same with an optional trailing `%`, stripped never scaled; blank → `null`; anything else an error naming the field). `Number(raw)` banned; the modal serialiser stops calling `parseLargeUSD` and hands the raw string to the same parser |
| 4 | `recompileContracts` can lose a race with the watcher's line rewrite | 3 | folded (**R-F4**) — `lib/print-watch/watcher.ts::writeLines` (ownership extended to THAT function only) wraps compile → `getSheet` → `reconcile` → `upsertLines` in ONE `.immediate()` transaction, so SQLite serialises it against the recompile in either order. No version fencing |
| 5 | evidence predicate too narrow; archive not carried; fixture unreliable | 3 | folded — evidence = `state='accepted'` OR `value` OR `value_high` OR `snippet` OR `audit_json` OR non-empty `candidates_json`; a retire-rename also renames the print's `print_watch_candidate_archive` rows; the fixture seeds through `upsertLines` with a compiled contract, and three new cases cover accepted+archive, snippet-only, and archive-only |
| 6 | bogey persistence and recompilation are not atomic | 4 | folded (with 13) — `saveBogeyWithRecompile` / `deleteBogeyWithRecompile` in `lib/mutations/earnings-bogeys.ts`, one `.immediate()` transaction each (the inner recompile becomes a SAVEPOINT — verified in better-sqlite3's `wrapTransaction`); a throwing recompile rolls the bogey write back, and a test proves it |
| 7 | cockpit polling wired backward | 6, 9 | folded (= F-S2) — `StreamSpec.run(signal, fetchImpl, trigger)`; `start` + `initialCockpit` → no request; `start` without it, `refresh`, `resume` → GET; `timer` → POST |
| 8 | expansion state leaks across print identity changes | 6, 9 | folded (= F-S1) — pure `nextOpenState({ was, decided, prevPrintId, next, manual })` with `prevPrintId` captured BEFORE the ref write; disappearance clears open + manual + ref. No mounted integration test: jsdom and React Testing Library are not dependencies and none may be added, so the correction case is driven through the reducer |
| 9 | hidden-tab start; parsed cools before the read begins | 9 | folded — the controller is created but not started when `document.visibilityState === "hidden"` at mount; `statusIntervalMs` also stays hot on `parsed` with no `read` and no `lastAttempt` (D schedules the read 5 s after the parse) |
| 10 | full-week cockpit enrichment incomplete | 5 | folded (= F-S3) — `lib/queries/earnings-intel.ts::allCockpitRows` (ownership extended, additive) also walks `payload.rowsByEvent`, deduped by `eventId`; `decorateCockpitIntel` and `cockpitRowsToIntelEvents` cover the week for free and the post-release filter is untouched. Residual (a) is closed |
| 11 | the IR-page field can erase existing configuration | 8 | folded — read-only `GET /api/print-watch/sources?symbol=` added to B's route (ownership extended; E never touches it); `IrPageField` loads on expand, disables Save until loaded, and CLEAR is its own explicit button, never a blank submit |
| 12 | slice E's repo guard will reject slice F | — | **no change in F (R-F12)** — the contract's §1 "Guard scope" paragraph (already amended) rules that E's guard scans `lib/**` and `app/api/**` only; `app/dashboard/**` is exempt by design because UI files carry the state words as TypeScript union members and display keys, not as SQL. F needs no allowlist entry and no shared client-safe constant |
| 13 | bogey route violates the API/layering conventions | 4 | folded (with 6) — the route becomes auth + parse + call; the envelope is ADDITIVE (`success: true` beside every key the modal already reads; failures `{ success: false, error }` at the same HTTP statuses) and the modal's parsing checks `data.success` |
| 14 | active prints outside the Hub week become unreachable | 9 | folded, cheap version (= F-S10, Codex rates High) — `LivePrintsOutsideWeek`, a SEPARATE top-level component rendered after `{children}` inside the provider, with one `LivePrintSlot` per orphan (`armed`) and its own symbol/window line. Residual (g) is closed |
| 15 | Today can display guessed or unprotected portfolio data | 7, 10 | folded — the IBKR line renders `—` with an honest title when nothing has a prior close (never `$0`), the missing-price count goes through `<Count>`, and a source assertion pins every `$`/`%`/count in that line. Task 7 states and asserts which chip figures are public market data and which are desk-derived |
| 16 | E2E starts from a live database without proving sanitisation | 11 | folded — privacy mode ON for every screenshot; captures stay in the gitignored worktree ledger; the log/screenshot scan runs against a gitignored canary list `data/private/e2e/canary.txt` (written by the session, never printed here). No sanitised fixture database — the copy never leaves the machine |
| 17 | several required F tests are nominal | 6, 8, 11 | folded — hidden-tab E2E asserts ALL FOUR streams silent and exactly one of each on return; `PrintOutputs`' render test passes `promote` (F-S8); Task 11 Step 4 states the post-merge integration gate (full suite, `tsc --noEmit`, `npm run build`, E2E on `main` with `outputs` present). "Correction during expansion" is the pure reducer test of #8 — stated plainly, with the reason no mounted test exists |
| 18 | the promised client-boundary guard is not actually added | 6 | folded — `tests/repo/hub-live-client-boundary.test.ts`: every `"use client"` file under `app/dashboard/today/**` importing `@/lib/{earnings,queries,digest,calendar}/…` or a non-allowlisted `@/lib/print-watch/…` must do so with `import type` |
| session F-S1 | the open-state reducer defeats its own print-id rule | 6, 9 | folded — see #8 |
| session F-S2 | cockpit first-run logic inverted against M-F3(c) | 6, 9 | folded — see #7 |
| session F-S3 | intel refresh + decoration must cover the week | 5 | folded — see #10 |
| session F-S4 | keyboard callout accept impossible on a secretless sandbox | 11 | folded — E2E step 5 seeds a done read plus two `proposed` callouts by SQL into the DB copy (synthetic labels), then accepts by keyboard against the real accept route |
| session F-S5 | the paste-box URL must be public https | 11 | folded — E2E step 4 uses a real public https EDGAR EX-99 URL of a PAST filing for a name NOT in the portfolio (the sandbox fetches it for real; `validatePublicUrl` is https-only and globally-routable-only); the file half keeps the gitignored fixture |
| session F-S6 | `getPrintById` runs outside the immediate transaction | 3 | folded — the existence check moved inside `run` |
| session F-S7 | `updated` may report key-order-only differences | 3 | folded — one sentence in the module comment so nobody chases it as a bug |
| session F-S8 | `PrintOutputs` Interfaces block omits `promote` | 8 | folded — `promote: { label; disabled; title; busy; onClick }` in the Interfaces block and in every `createElement` call in the test. Residual (d) is closed |
| session F-S9 | `stop()` uses `this.pause()` | 6 | folded — `stop()` calls a closure, so a destructured `stop` still works |
| session F-S10 | carryover prints outside the Hub's week | 9 | folded — see #14 (upgraded from "deferred minor" to the cheap UI because Codex rates it High) |
| session F-S11 | `EarningsRowChips` churns from prop (W2) to context (W3) | wave table | folded — the wave table now says so, so Task 7's reviewer does not flag the prop as dead |

**Substrate facts verified while folding** (read-only, `main` at `31d0e84f`): `lib/queries/earnings-bogeys.ts` has exactly TWO explicit SELECT column lists (`getBogeysForEvent`, `getPrimaryBogeyForEvent`) and `BogeysEditModal.tsx` is the route's only consumer; `parseLargeUSD` is `/^(-?)\s*\$?\s*([\d,]+(?:\.\d+)?)\s*([bmk])?\s*$/i` (so `6%` and `1e3` are already refused by it, and `Number()` is what let them through); `allCockpitRows` is a private helper at `lib/queries/earnings-intel.ts:92` feeding both `cockpitRowsToIntelEvents` and `decorateCockpitIntel`; `writeLines` (`lib/print-watch/watcher.ts:2491-2509`) is fully synchronous after its `claimLease` guard; `print_watch_lines` carries `value_high`, `snippet`, `audit_json` and `print_watch_candidate_archive` is keyed `(print_id, metric_id)`; better-sqlite3's `wrapTransaction` uses `SAVEPOINT`/`RELEASE`/`ROLLBACK TO` whenever `db.inTransaction`, so a nested `.immediate()` is a savepoint and a throw unwinds the outer transaction; `GET /api/print-watch/status` returns `eventId` but NO event date; `getPrintWatchSource` is a plain SELECT (safe in a GET); `validatePublicUrl` refuses anything but `https:`.

## Plan-level mechanics and deviations

M-F1 … M-F11 restate the decisions handed to this plan; M-F12 … M-F20 are mechanics this plan adds after reading the code. Every "fact to verify" from the brief is answered inline with a file:line citation. None re-opens a user ruling.

- **M-F1 — Today page removals (§4.6 bullet 1).** `app/dashboard/today/page.tsx` (486 lines) loses: the Alerts block and its `AlertGroup` helper, `getAlerts`, `triggeredToday`, the `EnrichedAlert` interface and the enrichment loop at `:91-114`; `NearbyLevelsCard` + `getLevelsNearPrice` (`:117`, `:333`); `<EarningsCockpit />` (`:274`); `<PrintWatchPanel />` (`:282`); `<MomentumPulse>` + `computeMomentumPulse` (`:172`, `:270`); `<SignificantMovesCard />` (`:337`). `TodayReleases` then spans the full row (the `grid md:grid-cols-2` at `:259` becomes a single full-width block). The **IBKR today** section (`:343-426`) collapses to ONE line: `IBKR today · <Count> names · <Money signed> today (<Pct>) · <IbkrRefreshButton /> · Accounts →`, where the money figure is `sum(h.today_gain)` over holdings whose `today_gain !== null`, the percent is that sum over `sum(h.current_value) - sum(h.today_gain)` (prior-close basis), and the link is `/dashboard/accounts`. The per-name list is gone from Today — it lives on Accounts. Surviving order: header → Portfolio strip → Releases → Hub → `OpenChatButton` → the one-line IBKR snapshot. A static test asserts the page source no longer imports the six removed modules and does import `EarningsHub`.
- **M-F2 — Analysis diagnostics gains the two cards (§4.6 bullet 2).** `app/dashboard/analysis/page.tsx` diagnostics branch renders `<SignificantMovesCard />` and `<MomentumPulse pulse={computeMomentumPulse(db)} />` in a `grid grid-cols-1 md:grid-cols-2 gap-4` directly under `<AnalysisViewToggle currentView="diagnostics" scope={params.scope} />` (`:313`) and above `<TrustStrip scope={scope} />` (`:315`). The two have **opposite data contracts** and the move is asymmetric: `SignificantMovesCard` takes no props and self-loads from the `db` singleton it imports (`app/dashboard/today/SignificantMovesCard.tsx:15,30`), so it is a drop-in; `MomentumPulse` is prop-driven (`app/dashboard/components/MomentumPulse.tsx:31-33,46`) and the page must import and call `computeMomentumPulse(db)` (`lib/compute/momentum-spread.ts:181`) itself. The analysis page already imports `db` (`:3`) and is `force-dynamic` (`:1`). `SignificantMovesCard.tsx` MOVES from `app/dashboard/today/` to `app/dashboard/components/`; its only code importer is `today/page.tsx:15` and there are ZERO test importers (verified repo-wide). `MomentumPulse` stays where it is (`app/dashboard/components/MomentumPulse.tsx`) — only its call site moves.
- **M-F3 — Hub = server rows + `EarningsHubLive` client controller (§4.6 bullet 3).** `EarningsHub` keeps every query it has (`EarningsHub.tsx:87-137`) and adds ONE: `buildCockpitPayload(db, new Date(), { weekOf })` followed by `decorateCockpitIntel(db, payload)` (both read-only), so the first paint carries stage chips with no fetch. `EarningsHubLive` (`"use client"`, new file) owns EVERY poll the two deleted components own today:
  - (a) **print-watch status** `GET /api/print-watch/status` — HOT at 2 000 ms when any print is `window_open`/`acquired`, or carries a `goRequest` whose `status` is `queued`/`claimed`, or carries an `activeRead`; COOL at 30 000 ms otherwise. (Today's panel is hot only on the two states — `PrintWatchPanel.tsx:163-165`; the go-request and active-read conditions are new, and are what "polling follows the print state" means once C and D have landed.)
  - (b) **`POST /api/print-watch/ensure` every 60 000 ms**, unconditionally, exactly as today (`PrintWatchPanel.tsx:769-775`) — it keeps the watcher lease alive and a failure is a `console.warn`, never a user-facing error.
  - (c) **cockpit** — *amended by Codex round 1 (#7 / F-S2).* The stream keys on its own `trigger`: `start` WITH an `initialCockpit` is a NO-OP — no request at all, because the server payload is the freshest thing there is; `start` WITHOUT one, and every `refresh` (a mutation) and `resume` (a tab coming back), is a `GET /api/earnings/cockpit?weekOf=`; ONLY the 60 000 ms `timer` run is the `POST` (the intel refresh, TTL-guarded server-side). A run that returns `null` never reaches `onResult`.
  - (d) **worksheet prepare** — `GET /api/earnings/worksheet?eventIds=…` every 60 000 ms, coalesced with (c).
  - (e) **mutation re-fetch** — every child action calls `onChanged()`, which issues an immediate status fetch AND an immediate cockpit GET; the existing `window` event `earnings-data-changed` (dispatched by `EarningsRowChips.tsx:317`) does the same.

  The mechanics live in a pure, React-free `createPollController` (`app/dashboard/today/hub-live/poll-controller.ts`) — per-stream generation counter (a response whose generation is lower than the latest issued is DROPPED), one `AbortController` per in-flight request, `pause()` (abort in flight, clear timers) and `resume()` (one immediate fetch per stream, timers restart), recursive `setTimeout` and never `setInterval`. `EarningsHubLive` calls `pause()` on `document.visibilityState === "hidden"` and on unmount, `resume()` on visible.
- **M-F4 — The email tri-state helpers move with the chips.** `chipFor`, `SEND_TONES`, `SEND_GLYPHS` and `fmtCountdown` leave `EarningsCockpit.tsx:55-92` for `app/dashboard/today/hub-live/send-state-chips.tsx`; `EarningsRowChips.tsx` renders the cockpit's stage chips (preview / released / actual / reaction / recap) plus the countdown and the intel line per row from the live cockpit payload, keeping its existing arm/skip/generate/view actions unchanged. `"delivery-unknown"` renders per contract §1: tone `warn`, glyph `?`, full-word label `delivery unknown`, `title` exactly `"The provider's response was never received — check the mailbox or the Resend log for the message id, then resend by hand if needed."`. `EmailSendState` / `PreviewStage` / `RecapStage` come from `@/lib/earnings/cockpit-stages` as a **type-only import** (M-F18); a test asserts every member of every union has a tone AND a glyph, so E's added member can never fall through to a raw state word.
- **M-F5 — `buildCockpitPayload` widened to the Hub's week.** New signature `buildCockpitPayload(db, now = new Date(), opts: { weekOf?: string } = {})`. With no `weekOf` the behaviour is byte-identical to today (`event_date IN (today, yesterday)`, `lib/queries/earnings-cockpit.ts:105-118`). With `weekOf` the event window is the seven dates `[weekOf … addDays(weekOf, 6)]` UNION `{ addDays(todayET(now), -1) }` — the carryover date keeps its exact current meaning (yesterday's unfinished prints), and it is added even when it falls outside the week so a Monday view still carries Sunday-night's unfinished row. Rows gain `event_date` (they already carry `eventDate`; the addition is `rowsByEvent`). `lanes` stays keyed `bmo`/`amc`/`unknown` over **today's** rows only, so every existing consumer is untouched; a new `rowsByEvent: Record<number, CockpitRow>` covers the whole window and is what the Hub keys on. `GET`/`POST /api/earnings/cockpit` accept `?weekOf=YYYY-MM-DD`, resolved through `resolveWeekOfParam` (`lib/calendar/date-utils.ts:188` — any date snaps to its Monday, garbage falls back to the current Monday, so the param can never 400). *Amended by Codex round 1 (#10 / F-S3):* the widening is only half the job — `lib/queries/earnings-intel.ts`'s private `allCockpitRows` (`:92`) feeds BOTH `decorateCockpitIntel` and `cockpitRowsToIntelEvents` from lanes + carryover, so a Thursday row would render with no intel and never be re-ensured before its day. F therefore edits that one helper ADDITIVELY to also walk `payload.rowsByEvent` (deduped by `eventId`); the post-release eligibility filter in `cockpitRowsToIntelEvents` is untouched. The earlier "STOP and escalate" instruction in Task 5 Step 3 is superseded.
- **M-F6 — Expansion (§4.6 bullet 4).** A row is ARMED when it carries a worksheet flag (`EnrichedRow.worksheetArmed`) OR the live status payload holds a print for its event id. An armed row renders a full-width sibling immediately after its `DesktopRow` (desktop) or its `MobileCard` (mobile) — see M-F13 for why no grid span is involved. `LivePrintRow` (`"use client"`) contains, in this order: the print header (state chip, window text, ladder text, go status) → `GoControls` (C's "Print is live" and "Extend 30 min" plus the NEW paste box) → `IrPageField` (M-F16) → the prepare status line (M-F15) → the road outcomes → the sheet (`LineRow` per line) → `FirstPassRead` (unchanged, imported) → `PrintOutputs`. Auto-expansion is TRANSITION-based through the pure `deriveExpansion(prev, next, manual)` (`hub-live/expansion.ts`): it opens when the print ENTERS `window_open` or `acquired`, when `forcedOpenAt` is newly set, or when a NEW `goRequest.id` appears; `parsed` on FIRST load does not auto-open. A manual toggle overrides and is remembered per print in `localStorage` under `vgs:print-expanded:<printId>` with `try/catch` around every access. The toggle is a full-word `expand`/`collapse` text `<button>` — no caret, keyboard-operable by construction. Callout accept is already a real `<button type="button">` (`FirstPassRead.tsx`), and a test asserts the moved markup contains no `div` with an `onClick`.
- **M-F7 — Layout at 1280 with the chat rail open (as corrected by M-F14).** The expansion row is a plain block sibling with `min-w-0` children and no fixed pixel width; every table inside it scrolls in its own `overflow-x-auto` (`<ScrollFade>`). The E2E at 1280 with the rail open asserts (i) `document.documentElement.scrollWidth === clientWidth` (no horizontal page scroll) and (ii) the Hub is rendering its MOBILE layout, because that is what `app/globals.css:405-410` already forces in that band.
- **M-F8 — Extra metric lines (§4.7).** `lib/print-watch/extra-metrics.ts` (pure, no imports outside `./types`) exports `ExtraMetricSpec`, `parseExtraMetrics`, `detectExtraMetricConflicts` and `mergeExtraMetrics`. `compileContracts` reads `extra_metrics_json` (added to its SELECT at `lib/print-watch/contracts.ts:99-104`) and emits one `LineContract` per merged id with `metric_id = "x_<uuid>_<period>"`, `unit` mapped (`pct` → `percent`, the other three pass through), `currency: "USD"`, `segment: null`; `expected[metric_id]` is built from the merged consensus/whisper with the `source_label` of the bogey row that supplied the consensus. Conflicting ids are NOT compiled and come back in the new additive `conflicts` key (contract §5). `GET /api/earnings/bogeys?eventId=` gains `extraMetricConflicts`; `POST /api/earnings/bogeys` accepts `extra_metrics_json`, validates it server-side through `parseExtraMetrics` and 400s with the errors; `upsertBogey` / `UpsertBogeyInput` / `CONTENT_COLUMNS` carry the column. `BogeysEditModal` grows an "Extra metrics" editor and a conflict banner.
- **M-F9 — `recompileContracts(db, printId)` — explicit, transactional, retire-with-evidence.** In one `db.transaction(...).immediate()`: compile, then for every existing row of `print_watch_lines` for the print — (a) still compiled and every SEMANTIC field of `contract_json` (`unit`, `kind`, `basis`, `period`) unchanged → `UPDATE contract_json, expected_json` (label, definition and expected may change freely); (b) still compiled, a semantic field CHANGED, and the row has EVIDENCE (*amended by Codex round 1 #5* — `state = 'accepted'` OR `value IS NOT NULL` OR `value_high IS NOT NULL` OR `snippet IS NOT NULL` OR `audit_json IS NOT NULL` OR `candidates_json` non-empty; the narrow three-clause version silently deleted a line whose only trace was a snippet or an audit trail) → rename the old row's `metric_id` to `<metric_id>~retired~<n>`, set `state = 'retired'`, and rename the print's matching `print_watch_candidate_archive` rows with it (they were measured under the OLD definition), then INSERT the fresh row `pending`; (c) semantic change with NO evidence → overwrite in place; (d) no longer compiled → `retired` (renamed the same way) if it has evidence, else `DELETE`; (e) newly compiled → INSERT `pending`. Returns `{ added, updated, retired, deleted, conflicts }`. The rename is forced by the schema, not chosen: `print_watch_lines`' primary key is `(print_id, metric_id)`, so a retired row and its replacement cannot share a key. The invariant that makes it safe: `upsertLines` (`lib/print-watch/store.ts:102-140`) is a pure per-row `INSERT … ON CONFLICT(print_id, metric_id) DO UPDATE` inside a transaction — **it never deletes and never touches a row whose `metric_id` is absent from its input array** — so no later parse can resurrect, clobber or clear a `~retired~` row. `'retired'` is already a legal `print_watch_lines.state` (`lib/print-watch/types.ts:24`, shipped by slice B) and `retractDocument` already carves it out alongside `accepted` (`lib/print-watch/delivery.ts:156`). *Further amended by Codex round 1:* the existence check (`getPrintById`) moves INSIDE the transaction (F-S6) so a print deleted by a concurrent merge returns an honest empty report instead of failing a foreign key; the `updated` list may name a row whose stored `contract_json` differs only by JSON key order (rows written before F), which is an in-place rewrite of identical semantics and not a bug (F-S7, recorded in the module comment); and an archive row is NOT evidence ON the line — a line whose only trace is an archived candidate is DELETED and its archive rows stay under the old id (#5(c)).
- **M-F10 — Mobile.** The same controller and the same `LivePrintRow` render under `MobileCard`; the paste box's file input is a native `<input type="file">` (works on iOS Safari, and is the pattern the panel already uses at `PrintWatchPanel.tsx:1215-1225`). Paper printing stays Mac-side: the `Print sheet` button on a phone still POSTs to the Mac, which is the design — the phone is a remote control for the desk's printer, not a print client. Bottom nav is untouched.
- **M-F11 — Deletion hygiene.** `EarningsCockpit.tsx` and `PrintWatchPanel.tsx` are deleted in Task 10, in the same commit that removes their imports from `page.tsx` — never earlier, or `next build` breaks at a wave boundary. Their importers, verified repo-wide: `EarningsCockpit` — `app/dashboard/today/page.tsx:21` and `:274` only, no tests. `PrintWatchPanel` — `app/dashboard/today/page.tsx:23` and `:282`, plus `tests/dashboard/print-watch-panel.test.ts` (one symbol import block at `:3-19` and four `readFileSync("app/dashboard/today/PrintWatchPanel.tsx")` source scans at `:805`, `:829`, `:864`, `:901`). Task 8 re-points all five before Task 10 deletes the file. `app/globals.css:405-410` switches `.earnings-hub-desktop` / `.earnings-hub-mobile`; the expansion sibling lives INSIDE those two containers, so it obeys the same switch with no CSS change.

### Mechanics this plan adds (verified in code before writing)

- **M-F12 — The Hub's live wiring is a client PROVIDER wrapping SERVER children.** `EarningsHub` is a server component that imports the `db` singleton (`EarningsHub.tsx:21`) and runs eight queries at render; `DesktopRow` and `MobileCard` are prop-driven over the serialisable `EnrichedRow` but they render `EarningsDateChip`, `BogeysEditButton`, `EarningsDeleteButton` and `RecapFigureButton`, and moving them into a client module would drag that whole subtree across the boundary for no gain. So `EarningsHubLive` is a `"use client"` **context provider** that takes `weekOf`, `eventIds`, `initialCockpit` and `children`, and `EarningsHub` renders its day blocks INSIDE it, dropping a `<LivePrintSlot eventId={e.id} armed={e.worksheetArmed} />` client leaf immediately after each server row. Client leaves rendered inside a client provider's server children DO receive that provider's context (the provider is above them in the client tree at hydration), so one controller feeds every row with no prop drilling and no second poll. Reason: it is the only shape that satisfies the spec's own words — "`EarningsHub` renders server rows plus a client controller `EarningsHubLive`".
- **M-F13 — There is no grid to span; the expansion is a plain block sibling.** The brief's "`col-span-full` grid row" does not apply: `.earnings-hub-desktop` is `display:block` (`EarningsHub.tsx:186`, `hidden md:block`), the per-day wrapper is a plain `<div>` (`:211`), and the CSS grid lives on **each row** (`DesktopRow`'s own div, `:299-306`). A sibling rendered after `<DesktopRow>` is therefore already full width; `col-span-full` on it would be inert. The precedent for spanning INSIDE a row is the existing inline `style={{ gridColumn: "span 4 / span 4" }}` at `EarningsHub.tsx:337`. F renders the expansion as `<div className="px-5 py-3 border-b border-edge bg-canvas">` — the same shape the day-separator div already uses (`:213-222`).
- **M-F14 — At 1280 with the chat rail open the Hub is ALREADY the mobile layout.** `app/globals.css:404-411` forces `.earnings-hub-desktop { display:none !important }` and `.earnings-hub-mobile { display:block !important }` for `768px ≤ vw ≤ 1535px` while `html[data-chat-rail="open"]`. The rail is `--chat-rail-width: 480px` (720px expanded, 0 collapsed — `globals.css:354-367`, mirrored by `RAIL_WIDTH_PX`/`EXPANDED_WIDTH_PX` in `lib/chat/rail-layout.ts:16-17`) and is reserved as `padding-right` on `.chat-rail-reserve` at ≥1280px (`globals.css:371-376`, applied in `app/dashboard/layout.tsx:37`), leaving `1280 − 480 − 48 = ~752px` of content. So the 1280-rail-open case is not a desktop-grid reflow risk at all — it is the mobile card path, and what F must not break is that switch. The desktop-grid-with-rail case only exists at ≥1536px. This supersedes the brief's framing of M-F7 and is recorded as a plan deviation.
- **M-F15 — The prepare status line reads the worksheet route, because the status route has none.** `GET /api/print-watch/status` returns no prepare state (verified: its mapper at `app/api/print-watch/status/route.ts:85-131` returns `printId, eventId, symbol, state, sources, coverage, forcedOpenAt, windowExtendedUntil, effectiveWindow, goRequest, lines, documents, documentRoads, read, activeRead, lastAttempt, callouts` and nothing else). The ONLY route that returns prepare-step rows is `/api/earnings/worksheet`: `GET ?eventIds=1,2,3` → `{ success, flags, data: { prepare: Record<number, PrepareStepRow[]> } }` (`route.ts:99-113`) and `POST {action:"arm"}` → `{ success, armed, data: { enqueued, prepare } }` (`route.ts:69-73`). `PrepareStepRow` is `{ event_id, step, status: "pending"|"claimed"|"done"|"failed", input_fingerprint, attempts, last_error, updated_at }` (`lib/earnings/prepare-armed-event.ts:65`). The four registered steps are `con_id`, `consensus_row`, `intel`, `newsletter_rescan` (`lib/earnings/prepare-steps/index.ts:25-28`). Two rules follow: (i) the arm POST's `prepare` array is captured synchronously right after `enqueuePrepareSteps` while `runPrepareSteps` is deliberately un-awaited (`route.ts:57-62`), so it is the ENQUEUED state, not the run state — `EarningsRowChips` may show it optimistically but the truth comes from the 60-second GET; (ii) per the slice-B deferred-minors note in `docs/plans/TODO.md:88`, **an armed symbol with no stored IR page carries a permanently `pending` `ir_baseline` row — the Hub must not render it as stuck.** F's prepare line renders `pending` as `waiting` (never "stuck"/"failed"), and when the only non-`done` step is `ir_baseline` it says `waiting on an IR page` and the `IrPageField` below is the fix. *Amended by Codex round 1 (#11, #17a):* that field now READS the stored row before it can write one (M-F16), so "the fix" is a control that shows what is already configured rather than an empty box; and the prepare stream is one of the four the hidden-tab E2E asserts silent (Task 11 step 11), not an unpolled extra.
- **M-F16 — There is no IR-page control anywhere today; F builds one.** `PUT /api/print-watch/sources` shipped in slice B (`app/api/print-watch/sources/route.ts`) and has **zero** UI callers (verified: the only non-test references in the repo are the route itself). Body `{ symbol, irPageUrl, linkMustContain? }`; an EMPTY `irPageUrl` CLEARS the stored row and the response says `{ success:true, data:{ symbol, cleared: boolean } }`; `symbol` must match `/^[A-Z0-9.\-]{1,12}$/` after trim+uppercase; a bad URL comes back 400 with `IR page: <reason>` from `validatePublicUrl`. `IrPageField` is therefore a new component: one text input plus an optional "link must contain" input, a Save button, and honest copy for all three outcomes (saved / cleared / refused-with-reason). *Amended by Codex round 1 (#11):* a PUT-only control can erase a working configuration — open it, save, and an empty box clears the row. So B's route (ownership extended to it; E never touches it) gains a read-only `GET /api/print-watch/sources?symbol=` returning `{ symbol, irPageUrl, linkMustContain } | null` through `getPrintWatchSource` (`lib/print-watch/store.ts:591`, a plain SELECT — the `no-state-changing-get` guard stays satisfied); `IrPageField` fetches it when the row expands, renders what is stored, keeps Save DISABLED until the read lands, and makes clearing an explicit `clear the stored page` button rather than a blank submit.
- **M-F17 — `presentState` has no `retired` case today, so a retired line renders "pending".** `PrintWatchPanel.tsx:601-621` switches on the line state and falls through to `default: { text: "pending", icon: "⋯", tone: "neutral" }`. Slice B added `'retired'` to the type and the CHECK constraint but **no production code has ever written it** (the only reader is `lib/print-watch/delivery.ts:156`). F's `recompileContracts` becomes its first producer, so the moved `presentState` gains `case "retired": { text: "retired — definition changed", icon: "⌀", tone: "neutral" }`, and `LineRow` renders retired rows collapsed (the row itself, dimmed, with no accept control) under that caption.
- **M-F18 — Client-boundary discipline, and the guard that enforces it.** `tests/repo/print-watch-import-boundaries.test.ts:34-46` is a TEXT scan (it does not understand `import type`) with `CLIENT_SAFE = ["types", "first-pass-types", "reconcile", "first-pass-format"]` and `SERVER_ONLY_PREFIXES = ["node:", "better-sqlite3", "@/lib/db", "@/lib/ai/", "@/lib/queries/", "@/lib/digest/", "@/lib/earnings/"]`, plus a rule that a client-safe module may not import a sibling outside the allowlist. Consequences F must obey exactly:
  - `lib/print-watch/extra-metrics.ts` is added to `CLIENT_SAFE` and therefore may import **nothing but `./types`** — no `better-sqlite3`, not even `import type`.
  - `lib/print-watch/contracts.ts` and `lib/print-watch/recompile.ts` stay server-only and are never imported from a `"use client"` file.
  - `app/dashboard/today/hub-live/send-state-chips.tsx` imports `EmailSendState` / `PreviewStage` / `RecapStage` from `@/lib/earnings/cockpit-stages` with `import type` ONLY. That module is NOT client-safe: it imports `composeReleaseInstant` from `@/lib/calendar/reaction-snapshot` (which value-imports `@stoqey/ib`) and `REACTION_READY_MS` from `@/lib/calendar/enrichment-runner` (which value-imports `@stoqey/ib`, the Worker's yahoo module and half of `lib/`). A type-only import is erased before bundling and is safe; a value import from it would break `next build`. The repo guard does not cover `@/lib/earnings/*` inside `app/**`, so F adds its own one-line guard test.
  - Same rule for the cockpit payload types: `hub-live/types.ts` re-declares the wire shapes F consumes rather than importing `CockpitRow`/`CockpitPayload` from `@/lib/queries/earnings-cockpit` (a server module), exactly as `PrintWatchPanel.tsx` re-declares the status wire shape today.
- **M-F19 — The Δ column is masked whenever the bogey is (`docs/plans/TODO.md:91` item (a), ruling (ii)).** The sheet renders the bogey through `<PrivateText>` but prints Δ vs bogey in clear (`PrintWatchPanel.tsx:1366-1389`), so a masked bogey is recoverable from the actual by division. The user ruled this "a plain bug, not a design question: mask the delta wherever the bogey is masked, during the merge session". F is that session's branch (it starts from `main` with B/C/D already merged, so it is not a stacked branch), and F is the slice that moves `LineRow`, so F fixes it in the move: the Δ cell renders inside `<PrivateText>` whenever `line.expected` is non-null. Recorded here so the ruling is not lost.
- **M-F20 — The bogey content-column TODO closes with a guard, not a merge (`docs/plans/TODO.md:81`, "slice F's call").** `lib/mutations/earnings-bogeys.ts`'s `CONTENT_COLUMNS` (9 entries, `:38-55`) lacks `extra_metrics_json`; `lib/earnings/event-merge.ts`'s `BOGEY_CONTENT` (10 entries, `:102-112`) has it. F is the slice that owns the upsert, so F **adds `extra_metrics_json` to `CONTENT_COLUMNS`** (Task 4) — which is required anyway for the column to survive a newsletter re-scan's preserve-mode COALESCE — and then closes the item by adding `tests/repo/bogey-content-lists-agree.test.ts`, asserting `CONTENT_COLUMNS ⊆ BOGEY_CONTENT`. The lists are NOT merged: they mean different things (one drives `hasAnyContent` and preserve-mode, the other drives the merge SET list, which also carries `BOGEY_PROVENANCE`), each is already pinned against the live schema (`tests/repo/bogey-merge-columns.test.ts`), and merging them would change `hasAnyContent` for the provenance columns too. The guard makes the drift that the TODO worried about impossible without touching either list's meaning. `lib/earnings/event-merge.ts` is E-owned and F does NOT edit it — the new test only imports from it.
- **M-F21 — `sheetLineKeys` now sees the extra metrics, and that is correct.** `read.ts:238` computes `sheetLineKeys(compileContracts(db, eventId, symbol).contracts)` — from the COMPILED contracts, never from the persisted sheet. So an extra metric line's label immediately suppresses a duplicate callout for that figure (the desired behaviour: once the desk defines "Net new ARR" as a line, the model must not also propose it as a callout). A `~retired~` row can never reach `sheetLineKeys` because it is not compiled, and `isContradictedAccepted` returns `false` on it at its first statement (`read-facts.ts:39`, `line.state !== "accepted"`). Both verified.
- **M-F22 — Nothing in this slice touches the push gates, the Worker, or a migration.** Spec §5 says "**F**: none". If a task appears to need a schema change, STOP and escalate rather than adding one.

### Named rulings from Codex round 1 (binding)

- **R-F2 — Extra-metric identity is the id, and the protocol is add + remove. No operations API.** A spec whose id is absent from the stored row is an ADD; a stored id absent from the submission is a REMOVE (its line retires-with-evidence at the next recompile); a "changed id" is therefore an add plus a remove and can never lose evidence. Server enforcement is uuid-v4 validation plus uniqueness within a row — there is no persisted-id diff and no create/retire/revise verbs, because the spec's "immutable" means the UI never edits an id, not that the server must police one. *Why:* the two things that matter (no silent evidence loss, no orphaned line) already follow from the recompile's retire-with-evidence rule, so an operations API would be ceremony over the same outcome. *Cost if wrong:* a desk that re-mints an id loses a live line's CONTINUITY — the old row is retired beside a fresh pending one — never its evidence. Pinned by one server test (Task 4).
- **R-F4 — The watcher's sheet write is serialised against the recompile by one immediate transaction, not by version fencing.** `writeLines` (`lib/print-watch/watcher.ts`) currently compiles, reads the sheet, reconciles and upserts as four separate statements; the launchd sweep process can hold the watcher lease while the Next process serves a bogeys POST, so its stale `upsertLines` can overwrite a just-recompiled row (`upsertLines`' ON CONFLICT overwrites contract/expected/state/value for every non-accepted row). Wrapping that body — it is fully synchronous, no `await` inside — in one `db.transaction(...).immediate()` makes SQLite order the two writers in either direction, each seeing the other's committed state. *Why:* the cheapest correct fix that adds no column and no protocol; ownership is extended to THAT ONE FUNCTION only (contract §6). *Cost if wrong:* a definition the desk just changed is silently reverted to the pre-edit contract on the next parse, and the sheet shows a line measured under a definition nobody chose.
- **R-F12 — F needs no allowlist entry for slice E's email-state guard, and no shared client-safe constant.** E's repo guard against hand-written email-state literals scans `lib/**` and `app/api/**` — the server-side readers of the `earnings_emails.error` column. `app/dashboard/**` is exempt BY DESIGN: F's chip files carry the state words as TypeScript union members and display map keys (`EmailSendState`, `PreviewStage`, `RecapStage`), never as SQL, and F's maps are already pinned TOTAL over those unions by a type-level constraint plus a test. This is recorded in the cross-slice contract §1 ("Guard scope"), which the session amended; F cites it and changes nothing. *Why:* a display key is not a query predicate, and forcing the UI to import a server module for its labels is exactly the client-boundary break M-F18 exists to prevent. *Cost if wrong:* the two branches collide at merge with a guard failure naming F's chip files — visible immediately, fixed by an allowlist line, never a silent data error.

- **Amended by Codex round 1** (see the disposition table and the per-task Amendments blocks): M-F3(c) (trigger-keyed cockpit stream), M-F5 (`allCockpitRows` also walks `rowsByEvent`; the Task 5 escalation is superseded), M-F8 (unit-aware strict parsing; the modal hydrates stored ids and accepts a pasted one at add-row time), M-F9 (widened evidence, archive rename, `getPrintById` inside the transaction, key-order note, and R-F4 on the other side of the race), M-F15/M-F16 (`IrPageField` reads before it writes, through a new read-only sources GET). M-F1, M-F2, M-F4, M-F6, M-F7, M-F10, M-F11, M-F12, M-F13, M-F14, M-F17 … M-F22 stand as written.

## Global Constraints

Every task's requirements implicitly include this section. Values are copied verbatim from `CLAUDE.md` (root), the spec and the cross-slice contract.

**Slice ownership (BINDING — from the contract's §6 table).** F CREATES: `app/dashboard/today/{EarningsHubLive,LivePrintRow}.tsx`, `app/dashboard/today/live-print/*`, `app/dashboard/today/hub-live/*`, `lib/print-watch/{extra-metrics,recompile}.ts`, tests. F MODIFIES: `app/dashboard/today/{page,EarningsHub,EarningsRowChips,BogeysEditModal}.tsx`, `app/dashboard/analysis/page.tsx`, `lib/print-watch/contracts.ts`, `lib/queries/earnings-cockpit.ts`, `app/api/earnings/cockpit/route.ts`, `app/api/earnings/bogeys/route.ts`, `lib/mutations/earnings-bogeys.ts`, `tests/dashboard/{print-watch-panel,first-pass-read}.test.ts`, `tests/repo/print-watch-import-boundaries.test.ts`, docs. F MOVES `app/dashboard/today/SignificantMovesCard.tsx` → `app/dashboard/components/SignificantMovesCard.tsx`. F DELETES `app/dashboard/today/{EarningsCockpit,PrintWatchPanel}.tsx`.

**Four ADDITIVE ownership extensions after Codex round 1** — the contract's §6 F row now lists them, and E touches none of them:
1. `lib/queries/earnings-bogeys.ts` — `extra_metrics_json` joins the `EarningsBogey` interface and BOTH explicit SELECT column lists (`getBogeysForEvent`, `getPrimaryBogeyForEvent`). Additive: no existing field, order or predicate changes (Codex 1, Task 4).
2. `lib/queries/earnings-intel.ts` — the private `allCockpitRows` also walks `payload.rowsByEvent`, deduped by `eventId`. Additive: the post-release eligibility filter in `cockpitRowsToIntelEvents` is untouched (Codex 10 / F-S3, Task 5).
3. `app/api/print-watch/sources/route.ts` — a read-only `GET ?symbol=` beside slice B's existing `PUT`. No change to `PUT` (Codex 11, Task 8).
4. `lib/print-watch/watcher.ts` — **`writeLines` ONLY**: its compile → `getSheet` → `reconcile` → `upsertLines` body wrapped in one `db.transaction(...).immediate()`. Nothing else in that 2 500-line file may be touched (R-F4, Task 3).

**F NEVER edits** `lib/earnings/**`, `lib/digest/**`, `lib/calendar/**`, `lib/email.ts`, `lib/queries/earnings-emails.ts`, `lib/mutations/earnings-emails.ts`, `lib/earnings/cockpit-stages.ts`, `lib/earnings/event-merge.ts`, any `app/api/print-watch/**` route **other than the `sources` GET above**, any other function in `lib/print-watch/watcher.ts`, `workers/**`, or any file under `lib/db/migrations/`. **F adds NO migration** (spec §5: "**F**: none").

**Contract shapes F consumes from E (quoted verbatim; render defensively — on F's branch they are absent).**

```ts
// contract §1 — lib/earnings/cockpit-stages.ts after E:
export type EmailSendState = "sent" | "sent-by-cloud" | "in-flight" | "delivery-unknown" | null;
// PreviewStage and RecapStage gain "delivery-unknown" too.
```
F renders `"delivery-unknown"` with tone `warn`, glyph `?`, full-word label `delivery unknown`, and the title text exactly: `The provider's response was never received — check the mailbox or the Resend log for the message id, then resend by hand if needed.`

```ts
// contract §2 — GET /api/print-watch/status gains `outputs` per print:
export type RecapSendState =
  | "unsent" | "in-flight" | "sent" | "sent-by-cloud" | "delivery-unknown";

export interface PrintOutputs {
  printSheet: {
    /** true when at least one non-retired line carries a `value` (spec §4.5). */
    enabled: boolean;
    /** Domain copy when disabled, else null. */
    reason: string | null;
  };
  sendRecap: {
    /** true when the gate in §3 passes AND state is "unsent". */
    enabled: boolean;
    /** Gate refusal copy, or the state word when not unsent, else null. */
    reason: string | null;
    state: RecapSendState;
    /** Set when state is "delivery-unknown" or "sent" (local). */
    providerMessageId: string | null;
  };
}
```
**F's rule (contract, verbatim):** "the outputs row (`PrintOutputs.tsx`, inside `LivePrintRow`) renders ONLY when `print.outputs` is present in the payload; a payload without it (E unmerged) renders no buttons and no error. F's render test seeds a fixture WITH `outputs`."

```ts
// contract §3 — POST /api/print-watch/send-recap, 200 for EVERY coordination outcome:
export type SendRecapOutcome =
  | { outcome: "sent"; sentTo: string; providerMessageId: string; title: string }
  | { outcome: "in_progress" }
  | { outcome: "already_sent"; sentAt: string; sentBy: "local" | "cloud" }
  | { outcome: "delivery_unknown"; providerMessageId: string | null; since: string }
  | { outcome: "refused"; reason: string }
  | { outcome: "failed"; reason: string };
```
`POST /api/print-watch/print-sheet` body `{ printId }` → 200 `{success:true,data:{ road:"pdf"|"monospace", pages:number|null, symbol:string }}`, 409 with `outputs.printSheet.reason` when disabled. F renders `data.outcome` and `data.reason` VERBATIM.

```ts
// contract §4 — POST /api/print-watch/go (slice C, EXISTS): the paste box posts
{ eventId, url? }  or  { eventId, contentBase64, filename? }
// ack: { requestId, printId, forcedOpenAt, newlyArmed, wakeError: string | null }
```

```ts
// contract §5 — compileContracts gains ONE additive key (F owns this file):
export function compileContracts(db, eventId, symbol): {
  contracts: LineContract[];
  expected: Record<string, ExpectedValue>;
  conflicts: Array<{ id: string; fields: string[] }>;
};
```

**UI conventions (`CLAUDE.md` §Conventions/UI, verbatim values).**
- Use `<Chip>` (`app/dashboard/components/Chip.tsx`; tones `up | down | gold | info | neutral | warn`, sizes `xs | sm`), `<ScrollFade>`, `<SortableHeader>` + `useSortParam` (sort state in URL). `<dialog>` needs `m-auto`; headings need `whitespace-nowrap!`; text ≤17px needs 4.5:1 contrast; hover-only affordances are touch tap-traps (never `opacity-0` reveals — use always-visible text buttons plus the `pointer-coarse:after:` hit-area idiom the panel already uses).
- Mutating handlers check `res.ok` AND `data.success`, explain no-ops in domain language, revert optimistic state, and never leave an empty `catch {}`.
- No-data sections render `<EmptySection>`, never a silent `return null`.
- Every DB-loading `app/dashboard/**/page.tsx` exports `const dynamic = "force-dynamic"`.
- **Never define a component inside another component's body** (remount trap).
- **No carets as a dropdown affordance** — a pill row, a native `<select>` or an icon button instead. The expansion toggle is the full words `expand` / `collapse`.
- Mobile: `md:` (768px) separates phone from desktop; `pb-safe` + `viewport-fit=cover`; the bottom nav is untouched; `ChatDrawer` stays at the layout root.

**Privacy (`CLAUDE.md` §Privacy).** Portfolio-derived numbers render through `<Money>` / `<Pct>` / `<Shares>` / `<Count>` (`lib/privacy/components.tsx`); public market data (press-release actuals, consensus figures about a listed company, % moves) renders with plain `formatUSD`/`formatPercent`/`formatLargeUSD`. AI prose renders inside `<PrivateText>`. The user's own curated bogey is portfolio-derived and stays inside `<PrivateText>` — **and so does the Δ computed against it** (M-F19). `netExposure` on a cockpit row renders through `<Money>`. Render tests wrap components in `PrivacyProvider` (`@/lib/privacy/context`) exactly as `tests/dashboard/first-pass-read.test.ts:21-23` does.

**Dates & time.** All dates `YYYY-MM-DD`. Every user-facing "today"/week is ET-anchored: `todayET()` and `getCurrentMonday()` from `lib/calendar/date-utils.ts` (`todayET` at `:19`, `getCurrentMonday` at `:75`, `addDays` at `:86`, `resolveWeekOfParam` at `:188`). Never `new Date().toISOString().slice(0,10)`. Instants are ISO UTC strings compared with `Date.parse`. Clock displays use `toLocaleTimeString("en-US", { timeZone: "America/New_York", … })`.

**API pattern.** Routes are thin (logic in `lib/`); envelope `{success:true,data}` / `{success:false,error}`. `lib/auth/route-policy.ts` gets NO new entries — every route F touches is `human` by the proxy's default classification (session cookie + double-submit CSRF + trusted `Origin` on unsafe methods). **GET routes must stay read-only** — `tests/api/no-state-changing-get.test.ts` scans every GET body; `GET /api/earnings/cockpit` and `GET /api/earnings/bogeys` stay pure reads (the cockpit's intel refresh stays on POST). Every client mutation goes through `apiFetch` (`lib/http/apiFetch.ts` default export — it sets `x-csrf-token` on unsafe methods only); `makeApiFetch(readCsrf, fetchImpl)` (`:31`) is the injection seam tests use.

**Testing.** `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run <paths>`; the same prefix for `npx tsx`, `npx next build` and `npm run build`. In-memory SQLite through the real `runMigrations`. **No wall-clock sleeps** — `vi.useFakeTimers()` and injected clocks/fetches only. Every fixture the code compares against `todayET()` is seeded relative to `todayET()`. **React Testing Library and jsdom are NOT dependencies and none may be added**: component logic is designed as pure helpers in plain `.ts` files, and render assertions use React 19's own `react-dom/server` `renderToStaticMarkup`, with `readFileSync` source pins for wiring that has no render surface.

**No new npm dependencies.** No new environment variables (nothing to thread through `electron/settings-store.ts` or `electron/main.ts`).

**Commits.** Message in a temp file, BY PATHSPEC — `git commit <paths> -F <tempfile>` — never a bare `git commit`, never `-m`, never `git stash` / `git checkout` / `git clean` / `git reset` (parallel agents share the worktree).

**Committed docs and this plan carry SYNTHETIC identifiers only** — tickers `XMPL1`..`XMPL5`, synthetic event/print ids, and fixture paths under the gitignored `data/private/e2e/`. Real tickers, ids and figures go in the gitignored private ledger.

## File Structure

```
lib/print-watch/extra-metrics.ts                    # ExtraMetricSpec, parse/detect/merge — PURE, client-safe (Task 1)
lib/print-watch/contracts.ts                        # + extra_metrics_json in the SELECT, x_<uuid>_<period> lines, + conflicts (Task 2)
lib/print-watch/recompile.ts                        # recompileContracts — one immediate transaction (Task 3)
lib/print-watch/watcher.ts                          # writeLines ONLY: compile→reconcile→upsert in one .immediate() (R-F4, Task 3)
lib/mutations/earnings-bogeys.ts                    # + extra_metrics_json, CONTENT_COLUMNS, both SQL paths, saveBogeyWithRecompile/deleteBogeyWithRecompile (Task 4)
lib/queries/earnings-bogeys.ts                      # + extra_metrics_json on EarningsBogey and BOTH SELECTs (Codex 1, Task 4)
app/api/earnings/bogeys/route.ts                    # thin: extraMetrics + extraMetricConflicts on GET, validation on POST, {success} envelope (Task 4)
lib/queries/earnings-cockpit.ts                     # + opts.weekOf, + rowsByEvent, + event_date on the row (Task 5)
lib/queries/earnings-intel.ts                       # allCockpitRows also walks rowsByEvent, deduped (Codex 10 / F-S3, Task 5)
app/api/earnings/cockpit/route.ts                   # + ?weekOf= on GET and POST (Task 5)

app/dashboard/today/hub-live/poll-controller.ts     # createPollController — generations, abort, pause/resume (Task 6)
app/dashboard/today/hub-live/expansion.ts           # deriveExpansion + the localStorage helpers (Task 6)
app/dashboard/today/hub-live/types.ts               # client-side wire shapes (status entry, cockpit row, prepare row) (Task 6)
app/dashboard/today/hub-live/send-state-chips.tsx   # chipFor, SEND_TONES, SEND_GLYPHS, fmtCountdown, StageChips (Task 7)
app/dashboard/today/EarningsRowChips.tsx            # + stage chips / countdown / intel from the live payload (Task 7, then 9)

app/api/print-watch/sources/route.ts                # + a read-only GET ?symbol= beside B's PUT (Codex 11, Task 8)

app/dashboard/today/live-print/helpers.ts           # the panel's pure helpers, moved verbatim (Task 8)
app/dashboard/today/live-print/LineRow.tsx          # moved, + retired case, + masked Δ (Task 8)
app/dashboard/today/live-print/GoControls.tsx       # Print is live / Extend 30 min / the NEW paste box (Task 8)
app/dashboard/today/live-print/IrPageField.tsx      # PUT /api/print-watch/sources (Task 8)
app/dashboard/today/live-print/PrepareStatus.tsx    # prepare-step line (Task 8)
app/dashboard/today/live-print/PrintOutputs.tsx     # contract §2/§3 — three buttons, renders only with `outputs` (Task 8)
app/dashboard/today/LivePrintRow.tsx                # the expansion body: header + the six blocks + FirstPassRead (Task 8)

app/dashboard/today/EarningsHubLive.tsx             # "use client" provider: polls, context, LivePrintSlot,
                                                    #   LivePrintsOutsideWeek (top-level, Codex 14 / F-S10) (Task 9)
app/dashboard/today/EarningsHub.tsx                 # + initial cockpit payload, wraps rows, drops the slots (Task 9)

app/dashboard/today/page.tsx                        # removals + the one-line IBKR snapshot (Task 10)
app/dashboard/components/SignificantMovesCard.tsx   # MOVED from app/dashboard/today/ (Task 10)
app/dashboard/analysis/page.tsx                     # + the two diagnostics cards (Task 10)
DELETED: app/dashboard/today/EarningsCockpit.tsx, app/dashboard/today/PrintWatchPanel.tsx   (Task 10)

tests/print-watch/extra-metrics.test.ts             # Task 1
tests/repo/print-watch-import-boundaries.test.ts    # + "extra-metrics" in CLIENT_SAFE (Task 1)
tests/print-watch/contracts.test.ts                 # EXTEND (Task 2)
tests/print-watch/recompile.test.ts                 # Task 3
tests/api/earnings-bogeys-extra-metrics.test.ts     # Task 4
tests/dashboard/bogeys-edit-modal-extra-metrics.test.ts  # Task 4
tests/repo/bogey-content-lists-agree.test.ts        # Task 4 (closes the TODO)
tests/queries/earnings-cockpit.test.ts              # EXTEND (Task 5)
tests/dashboard/hub-live-poll-controller.test.ts    # Task 6
tests/dashboard/hub-live-expansion.test.ts          # Task 6 (+ nextOpenState, Codex 8 / F-S1)
tests/repo/hub-live-client-boundary.test.ts         # Task 6 (Codex 18 — type-only imports across the client line)
tests/api/print-watch-sources-get.test.ts           # Task 8 (Codex 11)
tests/dashboard/send-state-chips.test.ts            # Task 7
tests/dashboard/print-watch-panel.test.ts           # RE-POINTED to live-print/* (Task 8)
tests/dashboard/first-pass-read.test.ts             # RE-POINTED mount scan (Task 8)
tests/dashboard/live-print-row.test.ts              # Task 8
tests/dashboard/earnings-hub-live.test.ts           # Task 9
tests/dashboard/today-page-blocks.test.ts           # Task 10
docs/reference/ui-structure.md, docs/reference/earnings-pipeline.md,
docs/DECISIONS.md, docs/plans/TODO.md, CLAUDE.md    # Task 11
```

---
### Task 1: `extra-metrics.ts` — the pure spec module (M-F8a, M-F18)

**Files:**
- Create: `lib/print-watch/extra-metrics.ts`
- Modify: `tests/repo/print-watch-import-boundaries.test.ts:34` — add `"extra-metrics"` to `CLIENT_SAFE`
- Test: `tests/print-watch/extra-metrics.test.ts`

**Interfaces:**
- Consumes: `LineContract` from `@/lib/print-watch/types` (type-only; `types.ts` has zero imports and is on the client-safe allowlist).
- Produces (Tasks 2, 3, 4 all import exactly these):

```ts
export type ExtraMetricUnit = "usd" | "per_share" | "pct" | "count";
export type ExtraMetricKind = "point" | "range";
export type ExtraMetricPeriod = "Q" | "NQ_guide" | "FY_guide";
export type ExtraMetricBasis = "gaap" | "non_gaap" | "na";

export interface ExtraMetricSpec {
  /** Full uuid v4, minted client-side at add-row time and IMMUTABLE thereafter. */
  id: string;
  label: string;       // 1..60 chars after trim
  definition: string;  // 0..300 chars after trim
  unit: ExtraMetricUnit;
  kind: ExtraMetricKind;
  period: ExtraMetricPeriod;
  basis: ExtraMetricBasis;
  consensus?: number | null;
  whisper?: number | null;
}

/** The four fields that must AGREE across every bogey row carrying an id. */
export const SEMANTIC_FIELDS = ["unit", "kind", "period", "basis"] as const;

export function isUuidV4(value: string): boolean;
/** Strict: not-an-array, unknown keys, bad uuid, over-long label/definition,
 *  duplicate id WITHIN one row, and non-finite numbers are all errors.
 *  Returns every error it found; `specs` holds only the rows that passed. */
export function parseExtraMetrics(json: string | null): { specs: ExtraMetricSpec[]; errors: string[] };
/** Same id on >= 2 rows disagreeing on any SEMANTIC_FIELD. `fields` is sorted. */
export function detectExtraMetricConflicts(
  rows: Array<{ id: number; specs: ExtraMetricSpec[] }>,
): Array<{ id: string; fields: string[] }>;
/** One spec per id, semantics from the FIRST row that carried the id (rows are
 *  passed in bogey-rowid order), numbers first-non-null across rows. Ids that
 *  conflict are OMITTED. `sourceLabelById` names the row that supplied the
 *  consensus, for ExpectedValue.source_label. */
export function mergeExtraMetrics(
  rows: Array<{ id: number; sourceLabel: string | null; specs: ExtraMetricSpec[] }>,
): { specs: ExtraMetricSpec[]; conflicts: Array<{ id: string; fields: string[] }>; sourceLabelById: Record<string, string | null> };
/** The compiled line id for a spec: `x_<uuid>_<period>`. */
export function extraMetricId(spec: ExtraMetricSpec): string;
/** `pct` -> `percent`; the other three pass through unchanged. */
export function extraMetricUnitToContractUnit(unit: ExtraMetricUnit): LineContract["unit"];
```

#### Amendments (Codex round 1) — Task 1

Finding folded here: **3** (a coercing number reader can invent or discard a financial figure). This block REPLACES `readNumber` in Step 3, the two number lines in `parseExtraMetrics`' per-row body, and the `parseExtraMetrics` describe block in Step 1's test.

**Why the original is wrong.** `const n = typeof raw === "number" ? raw : Number(raw)` accepts `true` (→ 1), `"  "` (→ 0) and `"1e3"` (→ 1000), and rejects nothing a JS coercion can survive. A bogey is a number the desk will be judged against at 16:05; silently turning `true` into a consensus of 1, or `"6%"` into `null` on a `usd` line, is the number-trust class this repo has already been burned by. The fix is a UNIT-AWARE grammar with no coercion anywhere.

**Two ordering consequences, stated so the implementer does not have to guess.** (i) The unit is validated BEFORE the numbers, and when it is invalid the number checks are SKIPPED — there is no grammar to check against, and the row already carries an error. (ii) `consensus`/`whisper` may arrive as a JSON number (from an earlier save, or from `compileContracts` re-reading stored JSON) or as a string (from the modal, which now stops parsing and hands the raw text through — Task 4). Both round-trip; nothing else does.

Replacement for `readNumber` and the two grammars (drop `readNumber` entirely):

```ts
/**
 * Accepted spellings, per unit. `usd` mirrors lib/format.ts::parseLargeUSD
 * EXACTLY — optional sign, optional `$`, digits with thousands commas, optional
 * decimals, optional k/m/b scale word — so "$3,850,000,000", "3.85B" and "850M"
 * all parse and "6%", "1e3" and "three billion" do not. The scale word is the
 * ONLY multiplier: nothing here ever scales a percent.
 */
const USD_GRAMMAR = /^(-?)\s*\$?\s*([\d,]+(?:\.\d+)?)\s*([bmk])?\s*$/i;
/** per_share / count / pct: a plain decimal, nothing else. */
const DECIMAL_GRAMMAR = /^-?\d+(\.\d+)?$/;

const UNIT_HINT: Record<ExtraMetricUnit, string> = {
  usd: "a dollar figure like 3.85B, 850M or $3,850,000,000",
  per_share: "a plain decimal like 0.46",
  pct: "a plain decimal, with an optional trailing % (like 27.5 or 27.5%)",
  count: "a plain whole or decimal number",
};

/**
 * ONE number field, parsed against its row's unit. NEVER `Number(raw)`:
 * coercion is what turns `true` into 1 and "  " into 0.
 *
 * Empty is not an error — a desk that has a definition but no consensus yet is
 * the ordinary case, and `null` is how the sheet says "no bogey on this line".
 * `undefined` is returned ONLY to signal "an error was recorded"; the caller
 * marks the row bad and drops it.
 */
function readNumberForUnit(
  raw: unknown,
  unit: ExtraMetricUnit,
  index: number,
  field: string,
  errors: string[],
): number | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) {
      errors.push(`Metric ${index}: ${field} must be a finite number or empty.`);
      return undefined;
    }
    return raw;
  }
  if (typeof raw !== "string") {
    // A boolean, an object, an array. Number() would happily coerce the first.
    errors.push(`Metric ${index}: ${field} must be ${UNIT_HINT[unit]}, or empty.`);
    return undefined;
  }
  const text = raw.trim();
  if (text === "") return null;          // blank / whitespace-only: no bogey, not zero

  if (unit === "usd") {
    const m = USD_GRAMMAR.exec(text);
    if (!m) {
      errors.push(`Metric ${index}: ${field} must be ${UNIT_HINT.usd}, or empty.`);
      return undefined;
    }
    const sign = m[1] === "-" ? -1 : 1;
    const numeric = Number(m[2].replace(/,/g, ""));
    if (!Number.isFinite(numeric)) {
      errors.push(`Metric ${index}: ${field} must be ${UNIT_HINT.usd}, or empty.`);
      return undefined;
    }
    const suffix = m[3]?.toLowerCase();
    const multiplier = suffix === "b" ? 1_000_000_000 : suffix === "m" ? 1_000_000 : suffix === "k" ? 1_000 : 1;
    return sign * numeric * multiplier;
  }

  // pct may carry ONE trailing '%', which is stripped and never scaled: 27.5%
  // and 27.5 are the same percentage, and dividing by 100 here would silently
  // change the bogey the desk typed.
  const body = unit === "pct" && text.endsWith("%") ? text.slice(0, -1).trim() : text;
  if (!DECIMAL_GRAMMAR.test(body)) {
    errors.push(`Metric ${index}: ${field} must be ${UNIT_HINT[unit]}, or empty.`);
    return undefined;
  }
  const n = Number(body);
  if (!Number.isFinite(n)) {
    errors.push(`Metric ${index}: ${field} must be ${UNIT_HINT[unit]}, or empty.`);
    return undefined;
  }
  return n;
}
```

Replacement for the two number lines inside `parseExtraMetrics`' `parsed.forEach` body (they sit after the `basis` check; everything above them is unchanged):

```ts
    // The unit decides how the numbers are read, so a row with a bad unit is
    // already unusable and its numbers are not second-guessed.
    const unitOk = UNITS.includes(row.unit as ExtraMetricUnit);
    const consensus = unitOk
      ? readNumberForUnit(row.consensus, row.unit as ExtraMetricUnit, n, "consensus", errors)
      : null;
    const whisper = unitOk
      ? readNumberForUnit(row.whisper, row.unit as ExtraMetricUnit, n, "whisper", errors)
      : null;
    if (consensus === undefined || whisper === undefined) bad = true;
    if (bad) return;
```

Replacement for the `describe("parseExtraMetrics", …)` block in Step 1's test — the six original cases stay, the non-finite case is rewritten against the new message, and four coercion cases are added:

```ts
describe("parseExtraMetrics", () => {
  it("returns nothing and no error for null or an empty string (the common case)", () => {
    expect(parseExtraMetrics(null)).toEqual({ specs: [], errors: [] });
    expect(parseExtraMetrics("   ")).toEqual({ specs: [], errors: [] });
  });
  it("parses a well-formed array and defaults the two optional numbers to null", () => {
    const { specs, errors } = parseExtraMetrics(
      JSON.stringify([{ id: A, label: "Net new ARR", definition: "d", unit: "usd", kind: "point", period: "Q", basis: "na" }]),
    );
    expect(errors).toEqual([]);
    expect(specs).toEqual([spec({ definition: "d" })]);
  });
  it("rejects unknown keys by name rather than silently dropping them", () => {
    const { specs, errors } = parseExtraMetrics(
      JSON.stringify([{ ...spec(), colour: "red" }]),
    );
    expect(specs).toEqual([]);
    expect(errors).toEqual(['Metric 1: unknown field "colour".']);
  });
  it("rejects a bad uuid, an over-long label, an over-long definition and a bad enum", () => {
    const bad = JSON.stringify([
      { ...spec(), id: "nope" },
      { ...spec({ id: B }), label: "x".repeat(61) },
      { ...spec({ id: B }), definition: "y".repeat(301) },
      { ...spec({ id: B }), unit: "eur" },
    ]);
    const { specs, errors } = parseExtraMetrics(bad);
    expect(specs).toEqual([]);
    expect(errors).toEqual([
      "Metric 1: id must be a full uuid (v4).",
      "Metric 2: label must be 1 to 60 characters.",
      "Metric 3: definition must be 300 characters or fewer.",
      "Metric 4: unit must be one of usd, per_share, pct, count.",
    ]);
  });
  it("rejects a duplicate id inside ONE bogey row", () => {
    const { specs, errors } = parseExtraMetrics(JSON.stringify([spec(), spec({ label: "Twin" })]));
    expect(specs).toEqual([]);
    expect(errors).toEqual([`Metric 2: id ${A} appears twice on this sheet.`]);
  });
  it("rejects non-JSON and a non-array top level without throwing", () => {
    expect(parseExtraMetrics("{not json").errors).toEqual(["Extra metrics must be valid JSON."]);
    expect(parseExtraMetrics('{"id":"x"}').errors).toEqual(["Extra metrics must be a JSON array."]);
  });

  // --- unit-aware strict parsing (Codex round 1, finding 3) -----------------
  const one = (over: Record<string, unknown>) => parseExtraMetrics(JSON.stringify([{ ...spec(), ...over }]));

  it("reads the usd grammar — and ONLY the usd grammar — for a usd row", () => {
    expect(one({ consensus: "3.85B" }).specs[0].consensus).toBe(3_850_000_000);
    expect(one({ consensus: "850M" }).specs[0].consensus).toBe(850_000_000);
    expect(one({ consensus: "$3,850,000,000" }).specs[0].consensus).toBe(3_850_000_000);
    expect(one({ consensus: "-2.5k" }).specs[0].consensus).toBe(-2_500);
    expect(one({ consensus: 3_850_000_000 }).specs[0].consensus).toBe(3_850_000_000);
  });
  it("NEVER coerces: true, a bad unit spelling and scientific notation are errors, not numbers", () => {
    expect(one({ consensus: true }).errors).toEqual([
      "Metric 1: consensus must be a dollar figure like 3.85B, 850M or $3,850,000,000, or empty.",
    ]);
    expect(one({ consensus: "6%" }).errors).toEqual([
      "Metric 1: consensus must be a dollar figure like 3.85B, 850M or $3,850,000,000, or empty.",
    ]);
    expect(one({ unit: "count", consensus: "1e3" }).errors).toEqual([
      "Metric 1: consensus must be a plain whole or decimal number, or empty.",
    ]);
    expect(one({ consensus: "1e400" }).errors).toEqual([
      "Metric 1: consensus must be a dollar figure like 3.85B, 850M or $3,850,000,000, or empty.",
    ]);
    expect(one({ consensus: Number.POSITIVE_INFINITY }).errors).toEqual([]);   // JSON cannot carry Infinity
  });
  it("treats a whitespace-only string as NO bogey — null, never Number('  ') === 0", () => {
    const { specs, errors } = one({ consensus: "  ", whisper: "" });
    expect(errors).toEqual([]);
    expect(specs[0].consensus).toBeNull();
    expect(specs[0].consensus).not.toBe(0);
    expect(specs[0].whisper).toBeNull();
  });
  it("strips ONE trailing % on a pct row and never scales it", () => {
    expect(one({ unit: "pct", consensus: "27.5%" }).specs[0].consensus).toBe(27.5);
    expect(one({ unit: "pct", consensus: "27.5" }).specs[0].consensus).toBe(27.5);
    expect(one({ unit: "pct", consensus: "27.5%%" }).errors).toHaveLength(1);
  });
  it("takes a plain decimal for per_share and count, and refuses a dollar sign there", () => {
    expect(one({ unit: "per_share", consensus: "0.46" }).specs[0].consensus).toBe(0.46);
    expect(one({ unit: "count", consensus: "12000" }).specs[0].consensus).toBe(12_000);
    expect(one({ unit: "per_share", consensus: "$0.46" }).errors).toHaveLength(1);
  });
  it("does not second-guess the numbers when the unit itself is unreadable", () => {
    const { errors } = one({ unit: "eur", consensus: "nonsense" });
    expect(errors).toEqual(["Metric 1: unit must be one of usd, per_share, pct, count."]);
  });
});
```

The last case is worth reading twice: `JSON.parse` cannot produce `Infinity`, so the number branch's `Number.isFinite` guard only ever fires for a value handed in programmatically — the string `"1e400"` is refused by the grammar first, which is the case Codex actually named.

- [ ] **Step 1: Write the failing test**

`tests/print-watch/extra-metrics.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  parseExtraMetrics,
  detectExtraMetricConflicts,
  mergeExtraMetrics,
  extraMetricId,
  extraMetricUnitToContractUnit,
  isUuidV4,
  type ExtraMetricSpec,
} from "@/lib/print-watch/extra-metrics";

const A = "5b7a1f42-9c3e-4d18-8f6a-2e0b91c7d4a3";
const B = "0c9e2d71-4a5b-4c6d-9e8f-1a2b3c4d5e6f";

const spec = (o: Partial<ExtraMetricSpec> = {}): ExtraMetricSpec => ({
  id: A, label: "Net new ARR", definition: "Sequential change in annual recurring revenue.",
  unit: "usd", kind: "point", period: "Q", basis: "na", consensus: null, whisper: null, ...o,
});

describe("isUuidV4", () => {
  it("accepts a full v4 uuid and rejects short, wrong-version and garbage ids", () => {
    expect(isUuidV4(A)).toBe(true);
    expect(isUuidV4("5b7a1f42")).toBe(false);
    expect(isUuidV4("5b7a1f42-9c3e-1d18-8f6a-2e0b91c7d4a3")).toBe(false); // version 1
    expect(isUuidV4("")).toBe(false);
  });
});

describe("parseExtraMetrics", () => {
  it("returns nothing and no error for null or an empty string (the common case)", () => {
    expect(parseExtraMetrics(null)).toEqual({ specs: [], errors: [] });
    expect(parseExtraMetrics("   ")).toEqual({ specs: [], errors: [] });
  });
  it("parses a well-formed array and defaults the two optional numbers to null", () => {
    const { specs, errors } = parseExtraMetrics(
      JSON.stringify([{ id: A, label: "Net new ARR", definition: "d", unit: "usd", kind: "point", period: "Q", basis: "na" }]),
    );
    expect(errors).toEqual([]);
    expect(specs).toEqual([spec({ definition: "d" })]);
  });
  it("rejects unknown keys by name rather than silently dropping them", () => {
    const { specs, errors } = parseExtraMetrics(
      JSON.stringify([{ ...spec(), colour: "red" }]),
    );
    expect(specs).toEqual([]);
    expect(errors).toEqual(['Metric 1: unknown field "colour".']);
  });
  it("rejects a bad uuid, an over-long label, an over-long definition and a bad enum", () => {
    const bad = JSON.stringify([
      { ...spec(), id: "nope" },
      { ...spec({ id: B }), label: "x".repeat(61) },
      { ...spec({ id: B }), definition: "y".repeat(301) },
      { ...spec({ id: B }), unit: "eur" },
    ]);
    const { specs, errors } = parseExtraMetrics(bad);
    expect(specs).toEqual([]);
    expect(errors).toEqual([
      "Metric 1: id must be a full uuid (v4).",
      "Metric 2: label must be 1 to 60 characters.",
      "Metric 3: definition must be 300 characters or fewer.",
      'Metric 4: unit must be one of usd, per_share, pct, count.',
    ]);
  });
  it("rejects a duplicate id inside ONE bogey row", () => {
    const { specs, errors } = parseExtraMetrics(JSON.stringify([spec(), spec({ label: "Twin" })]));
    expect(specs).toEqual([]);
    expect(errors).toEqual([`Metric 2: id ${A} appears twice on this sheet.`]);
  });
  it("rejects non-JSON and a non-array top level without throwing", () => {
    expect(parseExtraMetrics("{not json").errors).toEqual(["Extra metrics must be valid JSON."]);
    expect(parseExtraMetrics('{"id":"x"}').errors).toEqual(["Extra metrics must be a JSON array."]);
  });
  it("rejects a non-finite number rather than storing NaN", () => {
    const { errors } = parseExtraMetrics('[{"id":"' + A + '","label":"L","definition":"","unit":"usd","kind":"point","period":"Q","basis":"na","consensus":"1e400"}]');
    expect(errors).toEqual(["Metric 1: consensus must be a finite number or empty."]);
  });
});

describe("detectExtraMetricConflicts", () => {
  it("is empty when one id appears once, or twice in full agreement", () => {
    expect(detectExtraMetricConflicts([{ id: 1, specs: [spec()] }])).toEqual([]);
    expect(detectExtraMetricConflicts([
      { id: 1, specs: [spec({ consensus: 5 })] },
      { id: 2, specs: [spec({ consensus: 7, label: "different label is fine" })] },
    ])).toEqual([]);
  });
  it("names the id and every disagreeing semantic field, sorted", () => {
    expect(detectExtraMetricConflicts([
      { id: 1, specs: [spec()] },
      { id: 2, specs: [spec({ unit: "pct", basis: "gaap" })] },
    ])).toEqual([{ id: A, fields: ["basis", "unit"] }]);
  });
});

describe("mergeExtraMetrics", () => {
  it("keeps the first row's semantics, fills numbers first-non-null, and names the consensus row", () => {
    const merged = mergeExtraMetrics([
      { id: 1, sourceLabel: "Sheet A", specs: [spec({ consensus: null, whisper: 3 })] },
      { id: 2, sourceLabel: "Sheet B", specs: [spec({ consensus: 11, whisper: 9 })] },
    ]);
    expect(merged.conflicts).toEqual([]);
    expect(merged.specs).toEqual([spec({ consensus: 11, whisper: 3 })]);
    expect(merged.sourceLabelById).toEqual({ [A]: "Sheet B" });
  });
  it("omits a conflicting id entirely and reports it", () => {
    const merged = mergeExtraMetrics([
      { id: 1, sourceLabel: "A", specs: [spec()] },
      { id: 2, sourceLabel: "B", specs: [spec({ kind: "range" }), spec({ id: B, label: "Backlog" })] },
    ]);
    expect(merged.specs.map((s) => s.id)).toEqual([B]);
    expect(merged.conflicts).toEqual([{ id: A, fields: ["kind"] }]);
  });
});

describe("id and unit mapping", () => {
  it("builds x_<uuid>_<period> and maps pct to percent", () => {
    expect(extraMetricId(spec({ period: "FY_guide" }))).toBe(`x_${A}_FY_guide`);
    expect(extraMetricUnitToContractUnit("pct")).toBe("percent");
    expect(["usd", "per_share", "count"].map(extraMetricUnitToContractUnit)).toEqual(["usd", "per_share", "count"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/print-watch/extra-metrics.test.ts`
Expected: FAIL — `Cannot find module '@/lib/print-watch/extra-metrics'`.

- [ ] **Step 3: Write the module**

`lib/print-watch/extra-metrics.ts` — it may import NOTHING but `./types`, and only as a type (M-F18):

```ts
/**
 * Desk-defined extra metric lines (spec §4.7). The desk stores an array of
 * these per bogey row in `earnings_bogeys.extra_metrics_json`; `compileContracts`
 * turns each merged id into one sheet line `x_<uuid>_<period>`.
 *
 * PURE and CLIENT-SAFE by contract: this module is on the allowlist in
 * tests/repo/print-watch-import-boundaries.test.ts, so it may import nothing
 * but `./types` — not even `import type Database from "better-sqlite3"` (the
 * guard is a text scan). The bogeys modal validates with the same code the
 * route validates with, which is the whole point of keeping it pure.
 */
import type { LineContract } from "./types";

export type ExtraMetricUnit = "usd" | "per_share" | "pct" | "count";
export type ExtraMetricKind = "point" | "range";
export type ExtraMetricPeriod = "Q" | "NQ_guide" | "FY_guide";
export type ExtraMetricBasis = "gaap" | "non_gaap" | "na";

export interface ExtraMetricSpec {
  id: string;
  label: string;
  definition: string;
  unit: ExtraMetricUnit;
  kind: ExtraMetricKind;
  period: ExtraMetricPeriod;
  basis: ExtraMetricBasis;
  consensus?: number | null;
  whisper?: number | null;
}

export const SEMANTIC_FIELDS = ["unit", "kind", "period", "basis"] as const;

const UNITS: ExtraMetricUnit[] = ["usd", "per_share", "pct", "count"];
const KINDS: ExtraMetricKind[] = ["point", "range"];
const PERIODS: ExtraMetricPeriod[] = ["Q", "NQ_guide", "FY_guide"];
const BASES: ExtraMetricBasis[] = ["gaap", "non_gaap", "na"];

const ALLOWED_KEYS = new Set([
  "id", "label", "definition", "unit", "kind", "period", "basis", "consensus", "whisper",
]);

export const MAX_LABEL = 60;
export const MAX_DEFINITION = 300;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuidV4(value: string): boolean {
  return typeof value === "string" && UUID_V4.test(value);
}

/** A number field: absent/null/"" is null; anything else must parse finite. */
function readNumber(raw: unknown, index: number, field: string, errors: string[]): number | null | undefined {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) {
    errors.push(`Metric ${index}: ${field} must be a finite number or empty.`);
    return undefined;
  }
  return n;
}

export function parseExtraMetrics(json: string | null): { specs: ExtraMetricSpec[]; errors: string[] } {
  if (json === null || json.trim() === "") return { specs: [], errors: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { specs: [], errors: ["Extra metrics must be valid JSON."] };
  }
  if (!Array.isArray(parsed)) return { specs: [], errors: ["Extra metrics must be a JSON array."] };

  const errors: string[] = [];
  const specs: ExtraMetricSpec[] = [];
  const seen = new Set<string>();

  parsed.forEach((raw, i) => {
    const n = i + 1;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push(`Metric ${n}: each entry must be an object.`);
      return;
    }
    const row = raw as Record<string, unknown>;
    let bad = false;

    for (const key of Object.keys(row)) {
      if (!ALLOWED_KEYS.has(key)) {
        errors.push(`Metric ${n}: unknown field "${key}".`);
        bad = true;
      }
    }
    const id = typeof row.id === "string" ? row.id : "";
    if (!isUuidV4(id)) {
      errors.push(`Metric ${n}: id must be a full uuid (v4).`);
      bad = true;
    } else if (seen.has(id)) {
      errors.push(`Metric ${n}: id ${id} appears twice on this sheet.`);
      bad = true;
    }
    const label = typeof row.label === "string" ? row.label.trim() : "";
    if (label.length < 1 || label.length > MAX_LABEL) {
      errors.push(`Metric ${n}: label must be 1 to ${MAX_LABEL} characters.`);
      bad = true;
    }
    const definition = typeof row.definition === "string" ? row.definition.trim() : "";
    if (definition.length > MAX_DEFINITION) {
      errors.push(`Metric ${n}: definition must be ${MAX_DEFINITION} characters or fewer.`);
      bad = true;
    }
    if (!UNITS.includes(row.unit as ExtraMetricUnit)) {
      errors.push(`Metric ${n}: unit must be one of ${UNITS.join(", ")}.`);
      bad = true;
    }
    if (!KINDS.includes(row.kind as ExtraMetricKind)) {
      errors.push(`Metric ${n}: kind must be one of ${KINDS.join(", ")}.`);
      bad = true;
    }
    if (!PERIODS.includes(row.period as ExtraMetricPeriod)) {
      errors.push(`Metric ${n}: period must be one of ${PERIODS.join(", ")}.`);
      bad = true;
    }
    if (!BASES.includes(row.basis as ExtraMetricBasis)) {
      errors.push(`Metric ${n}: basis must be one of ${BASES.join(", ")}.`);
      bad = true;
    }
    const consensus = readNumber(row.consensus, n, "consensus", errors);
    const whisper = readNumber(row.whisper, n, "whisper", errors);
    if (consensus === undefined || whisper === undefined) bad = true;
    if (bad) return;

    seen.add(id);
    specs.push({
      id,
      label,
      definition,
      unit: row.unit as ExtraMetricUnit,
      kind: row.kind as ExtraMetricKind,
      period: row.period as ExtraMetricPeriod,
      basis: row.basis as ExtraMetricBasis,
      consensus: consensus ?? null,
      whisper: whisper ?? null,
    });
  });

  return { specs: errors.length > 0 ? [] : specs, errors };
}

export function detectExtraMetricConflicts(
  rows: Array<{ id: number; specs: ExtraMetricSpec[] }>,
): Array<{ id: string; fields: string[] }> {
  const first = new Map<string, ExtraMetricSpec>();
  const disagreeing = new Map<string, Set<string>>();
  for (const row of rows) {
    for (const s of row.specs) {
      const seen = first.get(s.id);
      if (!seen) {
        first.set(s.id, s);
        continue;
      }
      for (const f of SEMANTIC_FIELDS) {
        if (seen[f] !== s[f]) {
          const set = disagreeing.get(s.id) ?? new Set<string>();
          set.add(f);
          disagreeing.set(s.id, set);
        }
      }
    }
  }
  return [...disagreeing.entries()]
    .map(([id, fields]) => ({ id, fields: [...fields].sort() }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function mergeExtraMetrics(
  rows: Array<{ id: number; sourceLabel: string | null; specs: ExtraMetricSpec[] }>,
): {
  specs: ExtraMetricSpec[];
  conflicts: Array<{ id: string; fields: string[] }>;
  sourceLabelById: Record<string, string | null>;
} {
  const conflicts = detectExtraMetricConflicts(rows);
  const blocked = new Set(conflicts.map((c) => c.id));
  const order: string[] = [];
  const merged = new Map<string, ExtraMetricSpec>();
  const sourceLabelById: Record<string, string | null> = {};

  for (const row of rows) {
    for (const s of row.specs) {
      if (blocked.has(s.id)) continue;
      const seen = merged.get(s.id);
      if (!seen) {
        order.push(s.id);
        merged.set(s.id, { ...s });
        if (s.consensus !== null && s.consensus !== undefined) sourceLabelById[s.id] = row.sourceLabel;
        continue;
      }
      if ((seen.consensus === null || seen.consensus === undefined) && s.consensus !== null && s.consensus !== undefined) {
        seen.consensus = s.consensus;
        sourceLabelById[s.id] = row.sourceLabel;
      }
      if ((seen.whisper === null || seen.whisper === undefined) && s.whisper !== null && s.whisper !== undefined) {
        seen.whisper = s.whisper;
      }
    }
  }
  for (const id of order) if (!(id in sourceLabelById)) sourceLabelById[id] = null;
  return { specs: order.map((id) => merged.get(id)!), conflicts, sourceLabelById };
}

export function extraMetricId(spec: ExtraMetricSpec): string {
  return `x_${spec.id}_${spec.period}`;
}

export function extraMetricUnitToContractUnit(unit: ExtraMetricUnit): LineContract["unit"] {
  return unit === "pct" ? "percent" : unit;
}
```

Then add `"extra-metrics"` to the allowlist in `tests/repo/print-watch-import-boundaries.test.ts:34`:

```ts
const CLIENT_SAFE = ["types", "first-pass-types", "reconcile", "first-pass-format", "extra-metrics"] as const;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/print-watch/extra-metrics.test.ts tests/repo/print-watch-import-boundaries.test.ts`
Expected: PASS — including the guard's "each client-safe module is itself free of server dependencies" case, which now scans `extra-metrics.ts` and must find only `./types`.

- [ ] **Step 5: Commit**

```bash
cat > /tmp/msg-f1.txt <<'MSG'
feat(print-watch): extra-metric specs — strict parse, semantic-conflict detection, first-non-null merge

Pure and client-safe (allowlisted in the import-boundary guard) so the bogeys
modal validates with the same code the route validates with.
MSG
git commit lib/print-watch/extra-metrics.ts tests/print-watch/extra-metrics.test.ts tests/repo/print-watch-import-boundaries.test.ts -F /tmp/msg-f1.txt
```

---
### Task 2: `compileContracts` emits the extra lines and returns `conflicts` (M-F8b, contract §5)

**Files:**
- Modify: `lib/print-watch/contracts.ts` — the SELECT at `:97-105`, the return type at `:94`, the return statement at `:235`, plus one new block before the guidance block
- Test: `tests/print-watch/contracts.test.ts` (EXISTS — extend it)

**Interfaces:**
- Consumes: `parseExtraMetrics`, `mergeExtraMetrics`, `extraMetricId`, `extraMetricUnitToContractUnit`, `ExtraMetricSpec` (Task 1).
- Produces (contract §5 — additive; the two existing keys keep their exact shape and content):

```ts
export function compileContracts(
  db: Database.Database,
  eventId: number,
  symbol: string,
): {
  contracts: LineContract[];
  expected: Record<string, ExpectedValue>;
  conflicts: Array<{ id: string; fields: string[] }>;
};
```

- [ ] **Step 1: Write the failing tests**

Append to `tests/print-watch/contracts.test.ts` (keep its existing imports; add `compileContracts` if it is not already imported):

```ts
describe("compileContracts — desk-defined extra metric lines (spec §4.7)", () => {
  const A = "5b7a1f42-9c3e-4d18-8f6a-2e0b91c7d4a3";
  const B = "0c9e2d71-4a5b-4c6d-9e8f-1a2b3c4d5e6f";
  const metric = (o: Record<string, unknown> = {}) => ({
    id: A, label: "Net new ARR", definition: "Sequential change in ARR.",
    unit: "usd", kind: "point", period: "Q", basis: "na", ...o,
  });

  function seed(db: Database.Database, rows: Array<{ label: string; extra: unknown[] | null; eps?: number }>): number {
    db.prepare(
      `INSERT INTO calendar_events (event_date, event_type, title, symbol, source)
       VALUES ('2026-09-10','earnings','XMPL1 Q3','XMPL1','manual')`,
    ).run();
    const eventId = Number(db.prepare(`SELECT last_insert_rowid() AS id`).get<{ id: number }>()!.id);
    for (const r of rows) {
      db.prepare(
        `INSERT INTO earnings_bogeys (event_id, source, source_label, eps_consensus, extra_metrics_json)
         VALUES (?, 'manual', ?, ?, ?)`,
      ).run(eventId, r.label, r.eps ?? null, r.extra === null ? null : JSON.stringify(r.extra));
    }
    return eventId;
  }

  it("emits one x_<uuid>_<period> line per merged id, with the mapped unit and the merged numbers", () => {
    const db = newDb();
    const eventId = seed(db, [
      { label: "Sheet A", extra: [metric({ whisper: 310_000_000 })] },
      { label: "Sheet B", extra: [metric({ consensus: 300_000_000 })] },
    ]);
    const { contracts, expected, conflicts } = compileContracts(db, eventId, "XMPL1");
    expect(conflicts).toEqual([]);
    const line = contracts.find((c) => c.metric_id === `x_${A}_Q`);
    expect(line).toEqual({
      metric_id: `x_${A}_Q`,
      label: "Net new ARR",
      definition: "Sequential change in ARR.",
      basis: "na",
      period: "Q",
      currency: "USD",
      unit: "usd",
      kind: "point",
      segment: null,
    });
    expect(expected[`x_${A}_Q`]).toEqual({
      value: 300_000_000, value_high: null, whisper: 310_000_000, source_label: "Sheet B",
    });
  });

  it("maps pct to the contract unit percent and carries kind range through", () => {
    const db = newDb();
    const eventId = seed(db, [{ label: "A", extra: [metric({ id: B, unit: "pct", kind: "range", period: "FY_guide", basis: "non_gaap", label: "FY op margin" })] }]);
    const { contracts } = compileContracts(db, eventId, "XMPL1");
    expect(contracts.find((c) => c.metric_id === `x_${B}_FY_guide`)).toMatchObject({
      unit: "percent", kind: "range", period: "FY_guide", basis: "non_gaap", currency: "USD", segment: null,
    });
  });

  it("does NOT compile a conflicting id and reports it in the new conflicts key", () => {
    const db = newDb();
    const eventId = seed(db, [
      { label: "A", extra: [metric()] },
      { label: "B", extra: [metric({ unit: "pct" })] },
    ]);
    const { contracts, expected, conflicts } = compileContracts(db, eventId, "XMPL1");
    expect(conflicts).toEqual([{ id: A, fields: ["unit"] }]);
    expect(contracts.some((c) => c.metric_id.startsWith("x_"))).toBe(false);
    expect(expected[`x_${A}_Q`]).toBeUndefined();
  });

  it("ignores an unreadable extra_metrics_json without losing the rest of the sheet", () => {
    const db = newDb();
    const eventId = seed(db, [{ label: "A", extra: null, eps: 1.23 }]);
    db.prepare(`UPDATE earnings_bogeys SET extra_metrics_json = '{not json' WHERE event_id = ?`).run(eventId);
    const { contracts, expected, conflicts } = compileContracts(db, eventId, "XMPL1");
    expect(conflicts).toEqual([]);
    expect(contracts.map((c) => c.metric_id)).toEqual(["eps_gaap_q", "eps_adj_q", "revenue_q"]);
    expect(expected["eps_adj_q"]).toMatchObject({ value: 1.23 });
  });

  it("is byte-identical to the pre-slice-F output when no row carries extra metrics", () => {
    const db = newDb();
    const eventId = seed(db, [{ label: "A", extra: null, eps: 0.46 }]);
    const out = compileContracts(db, eventId, "XMPL1");
    expect(out.conflicts).toEqual([]);
    expect(out.contracts.map((c) => c.metric_id)).toEqual(["eps_gaap_q", "eps_adj_q", "revenue_q"]);
  });
});
```

(`newDb()` is the file's existing in-memory helper — reuse it; if the file does not have one, add `const newDb = () => { const db = new Database(":memory:"); db.pragma("foreign_keys = ON"); runMigrations(db); return db; };`.)

- [ ] **Step 2: Run to verify it fails**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/print-watch/contracts.test.ts`
Expected: FAIL — `conflicts` is `undefined` and no `x_…` contract exists.

- [ ] **Step 3: Implement**

In `lib/print-watch/contracts.ts`:

(a) add the import (a server module importing the client-safe one is always fine):

```ts
import {
  parseExtraMetrics,
  mergeExtraMetrics,
  extraMetricId,
  extraMetricUnitToContractUnit,
} from "./extra-metrics";
```

(b) add `extra_metrics_json: string | null;` to `interface BogeyRow` and `extra_metrics_json` to the SELECT column list:

```sql
SELECT id, eps_consensus, eps_whisper, revenue_consensus_usd, revenue_whisper_usd,
       segment_breakdown_json, guidance_notes, source_label, extra_metrics_json
  FROM earnings_bogeys
 WHERE event_id = ?
 ORDER BY id ASC
```

(c) widen the return type to `{ contracts: LineContract[]; expected: Record<string, ExpectedValue>; conflicts: Array<{ id: string; fields: string[] }> }`.

(d) insert this block AFTER the guidance block and BEFORE `return`, so extra lines sort last in the compiled order:

```ts
  // Desk-defined extra metric lines (spec §4.7). A row whose stored JSON does
  // not parse contributes NOTHING and takes nothing else down — the same
  // convention segment_breakdown_json already uses above. Conflicting ids are
  // not compiled; the modal reports them from the additive `conflicts` key.
  const extraRows = rows.map((row) => ({
    id: row.id,
    sourceLabel: row.source_label,
    specs: parseExtraMetrics(row.extra_metrics_json).specs,
  }));
  const { specs: extraSpecs, conflicts, sourceLabelById } = mergeExtraMetrics(extraRows);

  for (const spec of extraSpecs) {
    const metricId = extraMetricId(spec);
    if (contracts.some((c) => c.metric_id === metricId)) continue; // never shadow a built-in id
    contracts.push({
      metric_id: metricId,
      label: spec.label,
      definition: spec.definition,
      basis: spec.basis,
      period: spec.period,
      currency: "USD",
      unit: extraMetricUnitToContractUnit(spec.unit),
      kind: spec.kind,
      segment: null,
    });
    const consensus = spec.consensus ?? null;
    const whisper = spec.whisper ?? null;
    if (consensus !== null || whisper !== null) {
      expected[metricId] = {
        value: consensus,
        value_high: null,
        whisper,
        source_label: sourceLabelById[spec.id] ?? null,
      };
    }
  }
```

(e) `return { contracts, expected, conflicts };`

- [ ] **Step 4: Run the tests to verify they pass**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/print-watch/ tests/api/print-watch-first-pass.test.ts` and `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E 'contracts|compileContracts' ; echo "tsc filtered done"` (must print only the trailing marker).
Expected: PASS. Every existing caller destructures `{ contracts, expected }` and is unaffected by the third key — verify with `grep -rn "compileContracts(" lib/ app/ tests/` that no caller uses positional/array destructuring.

- [ ] **Step 5: Commit**

```bash
cat > /tmp/msg-f2.txt <<'MSG'
feat(print-watch): compile one sheet line per desk-defined extra metric

Adds extra_metrics_json to the bogeys SELECT, emits x_<uuid>_<period> contracts
with the mapped unit, and returns conflicting ids in a new additive key rather
than compiling a line nobody can trust.
MSG
git commit lib/print-watch/contracts.ts tests/print-watch/contracts.test.ts -F /tmp/msg-f2.txt
```

---
### Task 3: `recompileContracts` — explicit, transactional, retire-with-evidence (M-F9)

**Files:**
- Create: `lib/print-watch/recompile.ts`
- Test: `tests/print-watch/recompile.test.ts`

**Interfaces:**
- Consumes: `compileContracts` (Task 2), `getPrintById` (`lib/print-watch/store.ts:719`), `LineContract` / `ExpectedValue` (`./types`).
- Produces (Task 4 calls exactly this):

```ts
export interface RecompileReport {
  added: string[];      // metric_ids inserted pending
  updated: string[];    // metric_ids whose contract/expected changed in place
  retired: string[];    // the NEW (renamed) metric_ids of retired rows
  deleted: string[];    // metric_ids removed outright (no evidence)
  conflicts: Array<{ id: string; fields: string[] }>;
}
/** Re-derives one print's sheet from its bogey rows. One immediate
 *  transaction; a print that does not exist returns an all-empty report. */
export function recompileContracts(db: Database.Database, printId: number): RecompileReport;
/** The retired-row rename: `<metric_id>~retired~<n>`, n = the smallest free
 *  integer for that base id within the print. Exported for the test. */
export function retiredMetricId(base: string, taken: ReadonlySet<string>): string;
```

#### Amendments (Codex round 1) — Task 3

Findings folded here: **4** (R-F4 — the watcher can lose the race), **5** (evidence is wider than three columns; the candidate archive must follow a rename; the fixture seeded evidence on a guessed metric id), **F-S6** (`getPrintById` outside the transaction), **F-S7** (key-order-only `updated` entries). This block REPLACES Step 3's `Row` interface, `hasEvidence`, `recompileContracts` and the module comment's closing paragraph, ADDS the `writeLines` edit, and REPLACES two of Step 1's tests while adding four.

**Files (amended):**
- Create: `lib/print-watch/recompile.ts`
- **Modify: `lib/print-watch/watcher.ts` — `writeLines` (`:2491-2509`) ONLY** (ownership extended to that one function; contract §6)
- Test: `tests/print-watch/recompile.test.ts` (now also carries the `writeLines` source scan, so no new test file and no second claim on the watcher)

**(a) R-F4 — the other half of the race.** `upsertLines`' `ON CONFLICT` overwrites `contract_json`, `expected_json`, `state`, `value`, `value_high`, `snippet` and `source_doc_id` for every row that is not `accepted`. `writeLines` compiles, reads the sheet, reconciles and upserts as four separate statements, so a sweep process holding the watcher lease can compile BEFORE a bogeys POST recompiles and upsert AFTER it — reverting the desk's just-saved definition with no error anywhere. The body is fully synchronous (verified: no `await` between `claimLease` and the `return`), so one immediate transaction fixes it with no column and no protocol:

```ts
function writeLines(
  db: Database.Database,
  printId: number,
  eventId: number,
  symbol: string,
  all: TaggedCandidate[],
): boolean {
  if (!claimLease(db)) {
    statusFor(printId).sources.pipeline = "lease lost mid-parse — sheet write refused";
    return false;
  }
  // Slice F (R-F4): compile → read → reconcile → write is ONE transaction.
  // `recompileContracts` (lib/print-watch/recompile.ts) rewrites the same rows
  // from the same compiler when the desk edits a bogey, and the two run in
  // different PROCESSES (the launchd sweep holds the lease while the Next
  // server serves POST /api/earnings/bogeys). Without this, a compile taken
  // before the recompile can be written after it and silently revert a
  // definition the desk just changed. Both sides use .immediate(), so SQLite
  // orders them either way round and each sees the other's committed state.
  // The lease claim stays OUTSIDE: it is the cross-process arbiter, not part
  // of the write, and holding a write lock across it would serialise the whole
  // watcher against every reader.
  const run = db.transaction(() => {
    const { contracts, expected } = compileContracts(db, eventId, symbol);
    const accepted = getSheet(db, printId).filter((l) => l.state === "accepted");
    const lines = reconcile(contracts, expected, all, accepted).map((line) =>
      line.source_doc_id === FLASH_DOC_ID ? { ...line, source_doc_id: null } : line,
    );
    upsertLines(db, printId, lines);
  });
  run.immediate();
  return true;
}
```

(`upsertLines` opens its own `db.transaction`; nested, better-sqlite3 turns that into a `SAVEPOINT` — verified in `node_modules/better-sqlite3/lib/methods/transaction.js::wrapTransaction`, which switches to `SAVEPOINT`/`RELEASE`/`ROLLBACK TO` whenever `db.inTransaction`. Nothing about its behaviour changes.)

**(b) Evidence, the archive, and the transaction boundary.** Replacement for the `Row` interface, `hasEvidence`, and `recompileContracts` in Step 3:

```ts
interface Row {
  metric_id: string;
  contract_json: string;
  state: string;
  value: number | null;
  value_high: number | null;
  snippet: string | null;
  candidates_json: string;
  audit_json: string | null;
}

/**
 * "This row has been measured, so its reading must survive a definition
 * change." EVERY persisted trace counts, not just the three the first draft
 * named: a line can carry a high end of a range, a verbatim snippet, or an
 * audit trail of an acceptance that was later withdrawn, with `value` null.
 * Deleting any of those loses the record of what was read off the wire.
 *
 * An archived CANDIDATE is deliberately NOT evidence on the line: rows in
 * `print_watch_candidate_archive` are candidates the line never adopted (they
 * are archived by migration 089's document-identity rebuild and by the
 * candidate-fate path), so a line whose only trace is an archive row was never
 * measured and is deleted — its archive rows simply stay under the old id.
 */
function hasEvidence(row: Row): boolean {
  if (row.state === "accepted") return true;
  if (row.value !== null) return true;
  if (row.value_high !== null) return true;
  if (row.snippet !== null) return true;
  if (row.audit_json !== null) return true;
  const trimmed = row.candidates_json.trim();
  return trimmed !== "" && trimmed !== "[]";
}

export function recompileContracts(db: Database.Database, printId: number): RecompileReport {
  const empty = (): RecompileReport => ({ added: [], updated: [], retired: [], deleted: [], conflicts: [] });

  const run = db.transaction((): RecompileReport => {
    // F-S6: INSIDE the transaction. A print deleted by a concurrent event merge
    // between an outside check and these INSERTs would fail the foreign key
    // instead of returning the honest "nothing to do" this function promises.
    const print = getPrintById(db, printId);
    if (!print) return empty();

    const { contracts, expected, conflicts } = compileContracts(db, print.event_id, print.symbol);
    const byId = new Map<string, LineContract>(contracts.map((c) => [c.metric_id, c]));

    const rows = db
      .prepare(
        `SELECT metric_id, contract_json, state, value, value_high, snippet, candidates_json, audit_json
           FROM print_watch_lines WHERE print_id = ? ORDER BY metric_id`,
      )
      .all(printId) as Row[];
    const taken = new Set(rows.map((r) => r.metric_id));

    const setContract = db.prepare(
      `UPDATE print_watch_lines SET contract_json = ?, expected_json = ?, updated_at = datetime('now')
        WHERE print_id = ? AND metric_id = ?`,
    );
    const rename = db.prepare(
      `UPDATE print_watch_lines SET metric_id = ?, state = 'retired', updated_at = datetime('now')
        WHERE print_id = ? AND metric_id = ?`,
    );
    // Codex 5: archived candidates were measured under the OLD definition and
    // belong to the retired row. Leaving them on the live id would hand the
    // fresh line evidence gathered against a contract it does not have.
    const renameArchive = db.prepare(
      `UPDATE print_watch_candidate_archive SET metric_id = ? WHERE print_id = ? AND metric_id = ?`,
    );
    const remove = db.prepare(`DELETE FROM print_watch_lines WHERE print_id = ? AND metric_id = ?`);
    const insert = db.prepare(
      `INSERT INTO print_watch_lines
         (print_id, metric_id, contract_json, expected_json, state, value, value_high, snippet, source_doc_id, candidates_json, updated_at)
       VALUES (?, ?, ?, ?, 'pending', NULL, NULL, NULL, NULL, '[]', datetime('now'))`,
    );

    const report: RecompileReport = { added: [], updated: [], retired: [], deleted: [], conflicts };
    const expectedJson = (id: string): string | null => {
      const e: ExpectedValue | undefined = expected[id];
      return e ? JSON.stringify(e) : null;
    };
    /** One retirement: rename the line AND the archive rows that belong to it. */
    const retire = (metricId: string): string => {
      const renamed = retiredMetricId(metricId, taken);
      taken.add(renamed);
      rename.run(renamed, printId, metricId);
      renameArchive.run(renamed, printId, metricId);
      report.retired.push(renamed);
      return renamed;
    };

    for (const row of rows) {
      // A row already retired by an earlier recompile is history: never
      // re-examined, never re-retired, never deleted.
      if (row.metric_id.includes("~retired~")) continue;

      const next = byId.get(row.metric_id);
      if (!next) {
        if (hasEvidence(row)) retire(row.metric_id);
        else {
          remove.run(printId, row.metric_id);
          report.deleted.push(row.metric_id);
        }
        continue;
      }

      byId.delete(row.metric_id); // consumed — whatever is left is new
      const nextContract = JSON.stringify(next);
      const nextExpected = expectedJson(row.metric_id);

      if (semanticallySame(row.contract_json, next)) {
        const storedExpected = db
          .prepare(`SELECT expected_json FROM print_watch_lines WHERE print_id = ? AND metric_id = ?`)
          .get(printId, row.metric_id) as { expected_json: string | null };
        if (row.contract_json !== nextContract || storedExpected.expected_json !== nextExpected) {
          setContract.run(nextContract, nextExpected, printId, row.metric_id);
          report.updated.push(row.metric_id);
        }
        continue;
      }

      if (hasEvidence(row)) {
        retire(row.metric_id);
        insert.run(printId, row.metric_id, nextContract, nextExpected);
        report.added.push(row.metric_id);
      } else {
        setContract.run(nextContract, nextExpected, printId, row.metric_id);
        report.updated.push(row.metric_id);
      }
    }

    for (const [metricId, contract] of byId) {
      insert.run(printId, metricId, JSON.stringify(contract), expectedJson(metricId));
      report.added.push(metricId);
    }

    report.added.sort();
    report.updated.sort();
    report.retired.sort();
    report.deleted.sort();
    return report;
  });

  return run.immediate();
}
```

**(c) Module comment — replace its closing paragraph** with (F-S7 and the two new invariants):

```ts
 * `retractDocument` (delivery.ts) already treats 'retired' like 'accepted':
 * evidence is trimmed, the reading is left alone.
 *
 * `updated` may name a row whose stored `contract_json` differs from the fresh
 * one ONLY in JSON key order (rows written by `upsertLines` before slice F
 * serialised the contract in a different field order). That is an in-place
 * rewrite of identical semantics, not a change — do not chase it as a bug.
 *
 * `writeLines` (watcher.ts) wraps its own compile→reconcile→upsert in the same
 * kind of immediate transaction (R-F4), which is what stops a stale watcher
 * write from reverting a recompiled row across processes.
```

**(d) Tests.** REPLACE the case `"DELETES an uncompiled line with no evidence and RETIRES one that has evidence"` — its `UPDATE … WHERE metric_id = 'revenue_guide_next'` guesses a metric id that `compileContracts` may not emit for this fixture, so it could pass while testing nothing — and ADD four cases. `seedSheet` (already in Step 1) is the only way evidence is seeded from here on: it writes through `upsertLines` with the REAL compiled contract, so the row is definitely one the compiler produced.

```ts
  it("DELETES an uncompiled line that carries no evidence at all", () => {
    const { db, eventId, printId } = fixture([metric()]);
    seedSheet(db, printId, eventId);                 // x_<A>_Q is compiled and pending
    db.prepare(`UPDATE earnings_bogeys SET extra_metrics_json = NULL WHERE event_id = ?`).run(eventId);

    const r = recompileContracts(db, printId);
    expect(r.deleted).toEqual([`x_${A}_Q`]);
    expect(r.retired).toEqual([]);
    expect(getSheet(db, printId).some((l) => l.metric_id.startsWith("x_"))).toBe(false);
    db.close();
  });

  it("RETIRES an uncompiled line whose ONLY evidence is a snippet (Codex 5b)", () => {
    const { db, eventId, printId } = fixture([metric()]);
    seedSheet(db, printId, eventId);
    db.prepare(`UPDATE print_watch_lines SET snippet = 'net new ARR of $275 million' WHERE print_id = ? AND metric_id = ?`)
      .run(printId, `x_${A}_Q`);
    db.prepare(`UPDATE earnings_bogeys SET extra_metrics_json = NULL WHERE event_id = ?`).run(eventId);

    const r = recompileContracts(db, printId);
    expect(r.retired).toEqual([`x_${A}_Q~retired~0`]);
    expect(r.deleted).toEqual([]);
    const old = getSheet(db, printId).find((l) => l.metric_id === `x_${A}_Q~retired~0`)!;
    expect(old.state).toBe("retired");
    expect(old.snippet).toBe("net new ARR of $275 million");
    db.close();
  });

  it("RETIRES on an audit trail or a range high alone, not just on a value", () => {
    for (const [column, value] of [["audit_json", `'[{"at":"2026-09-10T20:06:00Z","what":"accepted"}]'`], ["value_high", "4.1e9"]] as const) {
      const { db, eventId, printId } = fixture([metric()]);
      seedSheet(db, printId, eventId);
      db.prepare(`UPDATE print_watch_lines SET ${column} = ${value} WHERE print_id = ? AND metric_id = ?`)
        .run(printId, `x_${A}_Q`);
      db.prepare(`UPDATE earnings_bogeys SET extra_metrics_json = NULL WHERE event_id = ?`).run(eventId);
      expect(recompileContracts(db, printId).retired, column).toEqual([`x_${A}_Q~retired~0`]);
      db.close();
    }
  });

  it("carries the candidate ARCHIVE across a retire-rename (Codex 5a)", () => {
    const { db, eventId, printId } = fixture([metric()]);
    seedSheet(db, printId, eventId);
    db.prepare(`UPDATE print_watch_lines SET state = 'accepted', value = 275000000 WHERE print_id = ? AND metric_id = ?`)
      .run(printId, `x_${A}_Q`);
    db.prepare(
      `INSERT INTO print_watch_candidate_archive (print_id, metric_id, candidate_json, reason)
       VALUES (?, ?, '{"value":275000000}', 'duplicate-document')`,
    ).run(printId, `x_${A}_Q`);
    db.prepare(`UPDATE earnings_bogeys SET extra_metrics_json = ? WHERE event_id = ?`)
      .run(JSON.stringify([metric({ basis: "non_gaap" })]), eventId);

    const r = recompileContracts(db, printId);
    expect(r.retired).toEqual([`x_${A}_Q~retired~0`]);
    const archived = db
      .prepare(`SELECT metric_id FROM print_watch_candidate_archive WHERE print_id = ?`)
      .all(printId) as Array<{ metric_id: string }>;
    expect(archived.map((a) => a.metric_id)).toEqual([`x_${A}_Q~retired~0`]);
    db.close();
  });

  it("an ARCHIVE row alone is not evidence ON the line: the line is deleted and the archive keeps the old id (Codex 5c)", () => {
    const { db, eventId, printId } = fixture([metric()]);
    seedSheet(db, printId, eventId);                 // the line's own columns stay empty
    db.prepare(
      `INSERT INTO print_watch_candidate_archive (print_id, metric_id, candidate_json, reason)
       VALUES (?, ?, '{"value":1}', 'duplicate-document')`,
    ).run(printId, `x_${A}_Q`);
    db.prepare(`UPDATE earnings_bogeys SET extra_metrics_json = NULL WHERE event_id = ?`).run(eventId);

    const r = recompileContracts(db, printId);
    expect(r.deleted).toEqual([`x_${A}_Q`]);
    expect(r.retired).toEqual([]);
    const archived = db
      .prepare(`SELECT metric_id FROM print_watch_candidate_archive WHERE print_id = ?`)
      .all(printId) as Array<{ metric_id: string }>;
    expect(archived.map((a) => a.metric_id)).toEqual([`x_${A}_Q`]);
    db.close();
  });

  it("survives a print that vanishes: an unknown id returns the empty report from INSIDE the transaction (F-S6)", () => {
    const { db } = fixture(null);
    expect(recompileContracts(db, 9999)).toEqual({ added: [], updated: [], retired: [], deleted: [], conflicts: [] });
    db.close();
  });
```

(The last case replaces the original `"returns an empty report for a print id that does not exist"` — same assertion, renamed so the reason is visible.)

And the R-F4 source scan, in the same file so the watcher gets no second owner:

```ts
describe("writeLines is serialised against recompileContracts (R-F4)", () => {
  const src = readFileSync("lib/print-watch/watcher.ts", "utf8");
  const body = src.slice(src.indexOf("function writeLines("), src.indexOf("type ParsePassResult"));
  it("wraps compile → getSheet → reconcile → upsertLines in ONE immediate transaction", () => {
    expect(body).toMatch(/db\.transaction\(/);
    expect(body).toMatch(/\.immediate\(\)/);
    const tx = body.indexOf("db.transaction(");
    expect(body.indexOf("compileContracts(")).toBeGreaterThan(tx);
    expect(body.indexOf("upsertLines(")).toBeGreaterThan(tx);
  });
  it("keeps the lease claim OUTSIDE the transaction (it is the cross-process arbiter, not the write)", () => {
    expect(body.indexOf("claimLease(db)")).toBeLessThan(body.indexOf("db.transaction("));
  });
});
```
(add `import { readFileSync } from "node:fs";` to the test file's imports).

- [ ] **Step 1: Write the failing tests**

`tests/print-watch/recompile.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { recompileContracts, retiredMetricId } from "@/lib/print-watch/recompile";
import { upsertLines, getSheet } from "@/lib/print-watch/store";
import { compileContracts } from "@/lib/print-watch/contracts";
import type { PrintWatchLine } from "@/lib/print-watch/types";

const A = "5b7a1f42-9c3e-4d18-8f6a-2e0b91c7d4a3";
const metric = (o: Record<string, unknown> = {}) => ({
  id: A, label: "Net new ARR", definition: "Sequential change in ARR.",
  unit: "usd", kind: "point", period: "Q", basis: "na", ...o,
});

function fixture(extra: unknown[] | null) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.prepare(
    `INSERT INTO calendar_events (event_date, event_type, title, symbol, source)
     VALUES ('2026-09-10','earnings','XMPL1 Q3','XMPL1','manual')`,
  ).run();
  const eventId = Number((db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id);
  db.prepare(
    `INSERT INTO earnings_bogeys (event_id, source, source_label, eps_consensus, revenue_consensus_usd, extra_metrics_json)
     VALUES (?, 'manual', 'Sheet A', 0.46, 3850000000, ?)`,
  ).run(eventId, extra === null ? null : JSON.stringify(extra));
  db.prepare(
    `INSERT INTO print_watch_prints (event_id, symbol, event_date, state) VALUES (?, 'XMPL1', '2026-09-10', 'window_open')`,
  ).run(eventId);
  const printId = Number((db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id);
  return { db, eventId, printId };
}

/** Seeds the sheet exactly as the watcher would: every compiled contract as a
 *  pending line. */
function seedSheet(db: Database.Database, printId: number, eventId: number) {
  const { contracts, expected } = compileContracts(db, eventId, "XMPL1");
  const lines: PrintWatchLine[] = contracts.map((c) => ({
    metric_id: c.metric_id, contract: c, expected: expected[c.metric_id] ?? null,
    state: "pending", value: null, value_high: null, snippet: null,
    source_doc_id: null, candidates_json: "[]",
  }));
  upsertLines(db, printId, lines);
}

describe("retiredMetricId", () => {
  it("takes the first free ordinal for the base id", () => {
    expect(retiredMetricId("revenue_q", new Set())).toBe("revenue_q~retired~0");
    expect(retiredMetricId("revenue_q", new Set(["revenue_q~retired~0"]))).toBe("revenue_q~retired~1");
  });
});

describe("recompileContracts", () => {
  it("reports nothing to do when the bogeys have not changed", () => {
    const { db, eventId, printId } = fixture([metric()]);
    seedSheet(db, printId, eventId);
    const r = recompileContracts(db, printId);
    expect(r).toEqual({ added: [], updated: [], retired: [], deleted: [], conflicts: [] });
    db.close();
  });

  it("inserts a newly defined extra metric as a pending line", () => {
    const { db, eventId, printId } = fixture(null);
    seedSheet(db, printId, eventId);
    db.prepare(`UPDATE earnings_bogeys SET extra_metrics_json = ? WHERE event_id = ?`)
      .run(JSON.stringify([metric()]), eventId);
    const r = recompileContracts(db, printId);
    expect(r.added).toEqual([`x_${A}_Q`]);
    const line = getSheet(db, printId).find((l) => l.metric_id === `x_${A}_Q`)!;
    expect(line.state).toBe("pending");
    expect(line.contract.label).toBe("Net new ARR");
    db.close();
  });

  it("updates label, definition and expected in place when no semantic field moved", () => {
    const { db, eventId, printId } = fixture([metric()]);
    seedSheet(db, printId, eventId);
    db.prepare(`UPDATE earnings_bogeys SET extra_metrics_json = ? WHERE event_id = ?`)
      .run(JSON.stringify([metric({ label: "Net new ARR (renamed)", consensus: 300_000_000 })]), eventId);
    const r = recompileContracts(db, printId);
    expect(r).toMatchObject({ added: [], retired: [], deleted: [], updated: [`x_${A}_Q`] });
    const line = getSheet(db, printId).find((l) => l.metric_id === `x_${A}_Q`)!;
    expect(line.contract.label).toBe("Net new ARR (renamed)");
    expect(line.expected).toMatchObject({ value: 300_000_000 });
    db.close();
  });

  it("overwrites a semantic change IN PLACE when the line carries no evidence", () => {
    const { db, eventId, printId } = fixture([metric()]);
    seedSheet(db, printId, eventId);
    db.prepare(`UPDATE earnings_bogeys SET extra_metrics_json = ? WHERE event_id = ?`)
      .run(JSON.stringify([metric({ unit: "pct" })]), eventId);
    const r = recompileContracts(db, printId);
    expect(r.retired).toEqual([]);
    expect(r.updated).toEqual([`x_${A}_Q`]);
    expect(getSheet(db, printId).filter((l) => l.metric_id.includes("~retired~"))).toEqual([]);
    expect(getSheet(db, printId).find((l) => l.metric_id === `x_${A}_Q`)!.contract.unit).toBe("percent");
    db.close();
  });

  it("RENAMES and retires a semantically-changed line that carries evidence, and compiles a fresh pending one", () => {
    const { db, eventId, printId } = fixture([metric()]);
    seedSheet(db, printId, eventId);
    db.prepare(`UPDATE print_watch_lines SET state = 'accepted', value = 275000000 WHERE print_id = ? AND metric_id = ?`)
      .run(printId, `x_${A}_Q`);
    db.prepare(`UPDATE earnings_bogeys SET extra_metrics_json = ? WHERE event_id = ?`)
      .run(JSON.stringify([metric({ basis: "non_gaap" })]), eventId);

    const r = recompileContracts(db, printId);
    expect(r.retired).toEqual([`x_${A}_Q~retired~0`]);
    expect(r.added).toEqual([`x_${A}_Q`]);

    const sheet = getSheet(db, printId);
    const old = sheet.find((l) => l.metric_id === `x_${A}_Q~retired~0`)!;
    expect(old.state).toBe("retired");
    expect(old.value).toBe(275_000_000);              // evidence preserved
    expect(old.contract.basis).toBe("na");            // the definition it was measured under
    const fresh = sheet.find((l) => l.metric_id === `x_${A}_Q`)!;
    expect(fresh.state).toBe("pending");
    expect(fresh.value).toBeNull();
    expect(fresh.contract.basis).toBe("non_gaap");
    db.close();
  });

  it("DELETES an uncompiled line with no evidence and RETIRES one that has evidence", () => {
    const { db, eventId, printId } = fixture([metric()]);
    seedSheet(db, printId, eventId);
    db.prepare(`UPDATE print_watch_lines SET candidates_json = '[{"metric_id":"x","value":1}]' WHERE print_id = ? AND metric_id = 'revenue_guide_next'`).run(printId);
    db.prepare(`UPDATE earnings_bogeys SET extra_metrics_json = NULL WHERE event_id = ?`).run(eventId);

    const r = recompileContracts(db, printId);
    expect(r.deleted).toEqual([`x_${A}_Q`]);
    expect(getSheet(db, printId).some((l) => l.metric_id.startsWith("x_"))).toBe(false);
    db.close();
  });

  it("a retired row SURVIVES a later writeLines-equivalent upsert of the live contracts (the M-F9 invariant)", () => {
    const { db, eventId, printId } = fixture([metric()]);
    seedSheet(db, printId, eventId);
    db.prepare(`UPDATE print_watch_lines SET state = 'accepted', value = 275000000 WHERE print_id = ? AND metric_id = ?`)
      .run(printId, `x_${A}_Q`);
    db.prepare(`UPDATE earnings_bogeys SET extra_metrics_json = ? WHERE event_id = ?`)
      .run(JSON.stringify([metric({ kind: "range" })]), eventId);
    recompileContracts(db, printId);

    // The watcher's own path: recompute from the CURRENT contracts and upsert.
    seedSheet(db, printId, eventId);

    const old = getSheet(db, printId).find((l) => l.metric_id === `x_${A}_Q~retired~0`)!;
    expect(old.state).toBe("retired");
    expect(old.value).toBe(275_000_000);
    db.close();
  });

  it("passes the compiler's conflicts straight through and compiles no line for them", () => {
    const { db, eventId, printId } = fixture([metric()]);
    seedSheet(db, printId, eventId);
    db.prepare(
      `INSERT INTO earnings_bogeys (event_id, source, source_label, extra_metrics_json) VALUES (?, 'manual', 'Sheet B', ?)`,
    ).run(eventId, JSON.stringify([metric({ unit: "pct" })]));
    const r = recompileContracts(db, printId);
    expect(r.conflicts).toEqual([{ id: A, fields: ["unit"] }]);
    expect(r.deleted).toEqual([`x_${A}_Q`]);
    db.close();
  });

  it("returns an empty report for a print id that does not exist", () => {
    const { db } = fixture(null);
    expect(recompileContracts(db, 9999)).toEqual({ added: [], updated: [], retired: [], deleted: [], conflicts: [] });
    db.close();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/print-watch/recompile.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`lib/print-watch/recompile.ts`:

```ts
/**
 * Explicit, transactional recompile of one print's sheet (spec §4.7: "When a
 * semantic field changes on an `id` with evidence, the existing line is marked
 * `retired` (evidence preserved) and a new line is compiled.
 * `recompileContracts(db, printId)` is explicit and transactional.").
 *
 * WHY THE RENAME. `print_watch_lines`' primary key is (print_id, metric_id)
 * (migration 089), so a retired row and its replacement cannot share a key.
 * The retired row therefore takes `<metric_id>~retired~<n>` and keeps every
 * column it had. That is safe because `upsertLines` (store.ts) is a pure
 * per-row INSERT … ON CONFLICT DO UPDATE that never deletes and never touches
 * a metric_id absent from its input, and `~retired~` ids are never compiled —
 * so no later parse can resurrect or clobber one. `retractDocument`
 * (delivery.ts) already treats 'retired' like 'accepted': evidence is trimmed,
 * the reading is left alone.
 */
import type Database from "better-sqlite3";
import { compileContracts } from "./contracts";
import { getPrintById } from "./store";
import type { ExpectedValue, LineContract } from "./types";

export interface RecompileReport {
  added: string[];
  updated: string[];
  retired: string[];
  deleted: string[];
  conflicts: Array<{ id: string; fields: string[] }>;
}

/** The four fields that make a line a DIFFERENT measurement. Label, definition
 *  and the expected numbers may change freely — they are presentation and
 *  bogey, not identity. */
const SEMANTIC: Array<keyof LineContract> = ["unit", "kind", "basis", "period"];

export function retiredMetricId(base: string, taken: ReadonlySet<string>): string {
  for (let n = 0; ; n += 1) {
    const candidate = `${base}~retired~${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

interface Row {
  metric_id: string;
  contract_json: string;
  state: string;
  value: number | null;
  candidates_json: string;
}

function hasEvidence(row: Row): boolean {
  if (row.state === "accepted") return true;
  if (row.value !== null) return true;
  const trimmed = row.candidates_json.trim();
  return trimmed !== "" && trimmed !== "[]";
}

function semanticallySame(stored: string, next: LineContract): boolean {
  let parsed: LineContract;
  try {
    parsed = JSON.parse(stored) as LineContract;
  } catch {
    return false; // unreadable contract is never "the same measurement"
  }
  return SEMANTIC.every((f) => parsed[f] === next[f]);
}

export function recompileContracts(db: Database.Database, printId: number): RecompileReport {
  const empty: RecompileReport = { added: [], updated: [], retired: [], deleted: [], conflicts: [] };
  const print = getPrintById(db, printId);
  if (!print) return empty;

  const run = db.transaction((): RecompileReport => {
    const { contracts, expected, conflicts } = compileContracts(db, print.event_id, print.symbol);
    const byId = new Map<string, LineContract>(contracts.map((c) => [c.metric_id, c]));

    const rows = db
      .prepare(
        `SELECT metric_id, contract_json, state, value, candidates_json
           FROM print_watch_lines WHERE print_id = ? ORDER BY metric_id`,
      )
      .all(printId) as Row[];
    const taken = new Set(rows.map((r) => r.metric_id));

    const setContract = db.prepare(
      `UPDATE print_watch_lines SET contract_json = ?, expected_json = ?, updated_at = datetime('now')
        WHERE print_id = ? AND metric_id = ?`,
    );
    const rename = db.prepare(
      `UPDATE print_watch_lines SET metric_id = ?, state = 'retired', updated_at = datetime('now')
        WHERE print_id = ? AND metric_id = ?`,
    );
    const remove = db.prepare(`DELETE FROM print_watch_lines WHERE print_id = ? AND metric_id = ?`);
    const insert = db.prepare(
      `INSERT INTO print_watch_lines
         (print_id, metric_id, contract_json, expected_json, state, value, value_high, snippet, source_doc_id, candidates_json, updated_at)
       VALUES (?, ?, ?, ?, 'pending', NULL, NULL, NULL, NULL, '[]', datetime('now'))`,
    );

    const report: RecompileReport = { added: [], updated: [], retired: [], deleted: [], conflicts };
    const expectedJson = (id: string): string | null => {
      const e: ExpectedValue | undefined = expected[id];
      return e ? JSON.stringify(e) : null;
    };

    for (const row of rows) {
      // A row already retired by an earlier recompile is history: never
      // re-examined, never re-retired, never deleted.
      if (row.metric_id.includes("~retired~")) continue;

      const next = byId.get(row.metric_id);
      if (!next) {
        if (hasEvidence(row)) {
          const renamed = retiredMetricId(row.metric_id, taken);
          taken.add(renamed);
          rename.run(renamed, printId, row.metric_id);
          report.retired.push(renamed);
        } else {
          remove.run(printId, row.metric_id);
          report.deleted.push(row.metric_id);
        }
        continue;
      }

      byId.delete(row.metric_id); // consumed — whatever is left is new
      const nextContract = JSON.stringify(next);
      const nextExpected = expectedJson(row.metric_id);

      if (semanticallySame(row.contract_json, next)) {
        const storedExpected = db
          .prepare(`SELECT expected_json FROM print_watch_lines WHERE print_id = ? AND metric_id = ?`)
          .get(printId, row.metric_id) as { expected_json: string | null };
        if (row.contract_json !== nextContract || storedExpected.expected_json !== nextExpected) {
          setContract.run(nextContract, nextExpected, printId, row.metric_id);
          report.updated.push(row.metric_id);
        }
        continue;
      }

      if (hasEvidence(row)) {
        const renamed = retiredMetricId(row.metric_id, taken);
        taken.add(renamed);
        rename.run(renamed, printId, row.metric_id);
        report.retired.push(renamed);
        insert.run(printId, row.metric_id, nextContract, nextExpected);
        report.added.push(row.metric_id);
      } else {
        setContract.run(nextContract, nextExpected, printId, row.metric_id);
        report.updated.push(row.metric_id);
      }
    }

    for (const [metricId, contract] of byId) {
      insert.run(printId, metricId, JSON.stringify(contract), expectedJson(metricId));
      report.added.push(metricId);
    }

    report.added.sort();
    report.updated.sort();
    report.retired.sort();
    report.deleted.sort();
    return report;
  });

  return run.immediate();
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/print-watch/` and `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E 'recompile' ; echo "tsc filtered done"`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cat > /tmp/msg-f3.txt <<'MSG'
feat(print-watch): recompileContracts — explicit, transactional, retire-with-evidence

A semantic change on a line that carries evidence renames the old row to
<metric_id>~retired~<n>, state retired, and compiles a fresh pending line;
without evidence it overwrites in place. Retired rows survive every later
upsert because upsertLines never touches a metric_id absent from its input.

Evidence is every persisted trace (accepted, value, value_high, snippet,
audit trail, candidates), a retire-rename carries the candidate archive with
it, and the watcher's own writeLines now runs its compile-reconcile-upsert in
one immediate transaction so a stale sweep write cannot revert a recompiled
definition across processes.
MSG
git commit lib/print-watch/recompile.ts lib/print-watch/watcher.ts tests/print-watch/recompile.test.ts -F /tmp/msg-f3.txt
```

---
### Task 4: Bogeys mutation + route + modal editor + conflict banner + the recompile trigger (M-F8c/d, M-F9 trigger, M-F20)

**Files:**
- Modify: `lib/mutations/earnings-bogeys.ts` — `UpsertBogeyInput` (`:4-36`), `CONTENT_COLUMNS` (`:38-55`), `INSERT_SQL` (`:57-64`), `OVERWRITE_SQL` (`:68-83`), `upsertBogey`'s `stmt.run(...)` argument list (`:155-172`)
- Modify: `app/api/earnings/bogeys/route.ts` — GET adds `extraMetricConflicts`; POST accepts + validates `extra_metrics_json` and calls `recompileContracts` after the write; DELETE calls `recompileContracts` after the delete
- Modify: `app/dashboard/today/BogeysEditModal.tsx` — an "Extra metrics" editor in the add form, a conflict banner, and `extra_metrics_json` in the save body
- Create: `tests/api/earnings-bogeys-extra-metrics.test.ts`, `tests/dashboard/bogeys-edit-modal-extra-metrics.test.ts`, `tests/repo/bogey-content-lists-agree.test.ts`

**Interfaces:**
- Consumes: `parseExtraMetrics`, `detectExtraMetricConflicts`, `ExtraMetricSpec`, `MAX_LABEL`, `MAX_DEFINITION` (Task 1); `recompileContracts` (Task 3); `getPrintByEventId` (`lib/print-watch/store.ts:52`); `BOGEY_CONTENT` (`lib/earnings/event-merge.ts:102` — imported by the guard test only, never edited).
- Produces:

```ts
// lib/mutations/earnings-bogeys.ts
export interface UpsertBogeyInput { /* …existing fields… */ extra_metrics_json?: string | null }

// GET /api/earnings/bogeys?eventId=NN  (envelope unchanged — this route predates the {success} convention)
{ bogeys: EarningsBogey[]; extraMetricConflicts: Array<{ id: string; fields: string[] }> }

// POST /api/earnings/bogeys  body gains `extra_metrics_json?: string | null`
// 400 { error: string }  when parseExtraMetrics reports errors (errors joined with " ")
// 200 { id, created, skipped?, recompiled?: RecompileReport }

// DELETE /api/earnings/bogeys?id=NN
{ deleted: boolean; recompiled?: RecompileReport }
```

**Why this task owns the route.** `app/api/earnings/bogeys/route.ts` is edited exactly once in this plan; Task 3 deliberately shipped `recompileContracts` as a pure lib function with no caller so that the route has a single owner and a single wave.

**Live-print resolution for the trigger.** After the bogey write commits, resolve the event's print with `getPrintByEventId(db, eventId)` (`event_id` is `NOT NULL UNIQUE` on `print_watch_prints`, migration 085 — there is at most one) and call `recompileContracts` only when `print.state !== "expired" && print.state !== "disarmed"`. A missing print, or an expired one, is a no-op and `recompiled` is omitted. **Superseded in part by the amendments below: "after the bogey write commits" becomes "inside the same transaction as the bogey write".**

#### Amendments (Codex round 1) — Task 4

Findings folded here: **1** (existing extra metrics cannot be edited or reconciled), **2** (R-F2 — id identity, PARTIAL), **3** (the modal's serialiser half), **6 + 13** (the write and the recompile are not atomic; the route is not thin and has no envelope). This block REPLACES Step 3b's route entirely, ADDS a `lib/queries/earnings-bogeys.ts` edit and two new mutation entry points to Step 3a, REPLACES the modal's serialiser and its id control in Step 3c, and ADDS four tests.

**Files (amended):** adds `lib/queries/earnings-bogeys.ts` (ownership extended, additive) to the Modify list; everything else is unchanged.

**(a) Codex 1 — the GET must return what the modal has to preserve.** `EarningsBogey` gains `extra_metrics_json: string | null;` after `notes`, and the column joins BOTH explicit SELECT lists in `lib/queries/earnings-bogeys.ts` — `getBogeysForEvent` (which the route and the composer read) and `getPrimaryBogeyForEvent` (kept in step so the two can never disagree about a row's contents). Purely additive: no field, order or predicate changes, and every existing consumer just ignores the new key.

```sql
-- both statements, immediately after `notes`:
              segment_breakdown_json, guidance_notes, notes, extra_metrics_json, uploaded_at,
```

**(b) R-F2 — what identity means here, and what it does not.** The id IS the identity, and the protocol needs no verbs: a spec whose id is absent from the stored row is an ADD; a stored id absent from the submission is a REMOVE, whose line retires-with-evidence at the next recompile; a "changed id" is an add plus a remove, which is exactly what the desk means and never loses a reading. Server enforcement stays uuid-v4 validation plus uniqueness within a row. There is deliberately NO persisted-id diff and no create/retire/revise API (recorded as PARTIAL against Codex 2; cost-if-wrong is a lost line *continuity*, never lost evidence). One server test below pins the protocol end to end.

**(c) Codex 6 + 13 — one transaction, one owner, one envelope.** Add to `lib/mutations/earnings-bogeys.ts` (after `deleteBogey`). `lib/mutations` importing `lib/print-watch/recompile` introduces no cycle — verified: `recompile` imports only `./contracts` (types + its own SQL), `./store` and `./types`, and nothing under `lib/print-watch` imports `lib/mutations/earnings-bogeys`.

```ts
import { recompileContracts, type RecompileReport } from "@/lib/print-watch/recompile";
import { getPrintByEventId } from "@/lib/print-watch/store";

/** Named so the route and the tests can talk about it. */
export interface UpsertBogeyResult {
  id: number;
  created: boolean;
  skipped?: boolean;
}

/**
 * A print that is `expired` or `disarmed` has finished measuring: its sheet is
 * the RECORD of what was measured and is never re-derived. No print at all is
 * the ordinary case (most events never arm).
 */
function recompileLivePrint(db: Database.Database, eventId: number): RecompileReport | null {
  const print = getPrintByEventId(db, eventId);
  if (!print || print.state === "expired" || print.state === "disarmed") return null;
  return recompileContracts(db, print.id);
}

/**
 * Save a bogey and re-derive the event's live sheet in ONE transaction
 * (Codex round 1, finding 6). Committing the bogey and then recompiling
 * separately leaves a window — and, if the recompile throws, a permanent
 * state — in which the stored sheet disagrees with the stored bogeys: lines
 * for metrics nobody defines any more, or no line for one the desk just added
 * and is about to be judged against at 16:05.
 *
 * `recompileContracts` opens its own `.immediate()`; nested, better-sqlite3
 * runs it as a SAVEPOINT (lib/methods/transaction.js::wrapTransaction switches
 * to SAVEPOINT/RELEASE/ROLLBACK TO whenever db.inTransaction), so a throw
 * inside it unwinds this whole transaction — bogey write included.
 */
export function saveBogeyWithRecompile(
  db: Database.Database,
  input: UpsertBogeyInput,
): { result: UpsertBogeyResult; recompile: RecompileReport | null } {
  const run = db.transaction(() => {
    const result = upsertBogey(db, input);
    return { result, recompile: recompileLivePrint(db, input.event_id) };
  });
  return run.immediate();
}

/** The same guarantee for a removal — and the row's `event_id` is read BEFORE
 *  the DELETE, inside the transaction, so nothing can race between them. */
export function deleteBogeyWithRecompile(
  db: Database.Database,
  id: number,
): { deleted: boolean; recompile: RecompileReport | null } {
  const run = db.transaction(() => {
    const row = db.prepare(`SELECT event_id FROM earnings_bogeys WHERE id = ?`).get(id) as
      | { event_id: number }
      | undefined;
    const deleted = deleteBogey(db, id);
    if (!deleted || !row) return { deleted, recompile: null };
    return { deleted: true, recompile: recompileLivePrint(db, row.event_id) };
  });
  return run.immediate();
}
```

`upsertBogey`'s return annotation becomes `UpsertBogeyResult` (same shape, now named).

**(d) Step 3b REPLACEMENT — the thin route.** The envelope is ADDITIVE: every top-level key the modal reads today survives, `success: true` joins it, and failures become `{ success: false, error }` at the SAME HTTP statuses. `BogeysEditModal.tsx` is this route's only consumer (verified repo-wide), and Task 4 owns it, so the two move together.

```ts
import { db } from "@/lib/db";
import { getBogeysForEvent } from "@/lib/queries/earnings-bogeys";
import {
  saveBogeyWithRecompile,
  deleteBogeyWithRecompile,
} from "@/lib/mutations/earnings-bogeys";
import { parseExtraMetrics, detectExtraMetricConflicts } from "@/lib/print-watch/extra-metrics";

export const dynamic = "force-dynamic";

/**
 * GET    /api/earnings/bogeys?eventId=NN
 * POST   /api/earnings/bogeys           — manual entry (+ live-sheet recompile)
 * DELETE /api/earnings/bogeys?id=NN     — (+ live-sheet recompile)
 *
 * Thin by the API pattern: auth is the proxy's (human by default), this file
 * parses and delegates. Every write, and the recompile it implies, lives in
 * ONE library transaction (lib/mutations/earnings-bogeys.ts).
 *
 * The upload route lives at /api/earnings/bogeys/upload.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const eventId = Number(url.searchParams.get("eventId"));
  if (!Number.isInteger(eventId) || eventId <= 0) {
    return Response.json(
      { success: false, error: "Query param 'eventId' must be a positive integer." },
      { status: 400 },
    );
  }
  const bogeys = getBogeysForEvent(db, eventId);

  // Conflict detection walks the rows in ROWID order, which is the order
  // compileContracts merges in — so the modal's banner names exactly the ids
  // the compiler refused, and cannot disagree with the sheet. (getBogeysForEvent
  // is deliberately newest-issue-first for the composer; that ordering is right
  // for prose and wrong for merge semantics.)
  const byRowid = [...bogeys].sort((a, b) => a.id - b.id);
  const extraMetricConflicts = detectExtraMetricConflicts(
    byRowid.map((b) => ({ id: b.id, specs: parseExtraMetrics(b.extra_metrics_json).specs })),
  );

  // Each row republishes its PARSED specs so the modal can edit them WITHOUT
  // re-minting ids (Codex 1) — a re-minted id would retire a live line and
  // start a new one, losing its continuity. An unreadable stored value reports
  // itself rather than vanishing.
  const withSpecs = bogeys.map((b) => {
    const { specs, errors } = parseExtraMetrics(b.extra_metrics_json);
    return { ...b, extraMetrics: specs, extraMetricErrors: errors };
  });

  return Response.json({ success: true, bogeys: withSpecs, extraMetricConflicts });
}

interface ManualBogeyBody {
  event_id?: number;
  source_label?: string;
  eps_consensus?: number | null;
  eps_whisper?: number | null;
  revenue_consensus_usd?: number | null;
  revenue_whisper_usd?: number | null;
  /** Absolute percent (±6% → 6) — sheet/analyst expected earnings move. */
  expected_move_pct?: number | null;
  guidance_notes?: string | null;
  notes?: string | null;
  /** Desk-defined extra metric lines (spec §4.7), as a JSON string. */
  extra_metrics_json?: string | null;
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as ManualBogeyBody;
  if (typeof body.event_id !== "number" || !Number.isInteger(body.event_id)) {
    return Response.json(
      { success: false, error: "Body field 'event_id' must be an integer." },
      { status: 400 },
    );
  }

  let extraMetricsJson: string | null = null;
  if (body.extra_metrics_json !== undefined && body.extra_metrics_json !== null) {
    if (typeof body.extra_metrics_json !== "string") {
      return Response.json(
        { success: false, error: "Body field 'extra_metrics_json' must be a JSON string." },
        { status: 400 },
      );
    }
    // The SAME parser the modal validates with. The client check is a fast,
    // identical refusal; this one is the only one that decides.
    const { errors } = parseExtraMetrics(body.extra_metrics_json);
    if (errors.length > 0) {
      return Response.json({ success: false, error: errors.join(" ") }, { status: 400 });
    }
    extraMetricsJson = body.extra_metrics_json.trim() === "" ? null : body.extra_metrics_json;
  }

  const { result, recompile } = saveBogeyWithRecompile(db, {
    event_id: body.event_id,
    source: "manual",
    source_label: body.source_label ?? null,
    eps_consensus: body.eps_consensus ?? null,
    eps_whisper: body.eps_whisper ?? null,
    revenue_consensus_usd: body.revenue_consensus_usd ?? null,
    revenue_whisper_usd: body.revenue_whisper_usd ?? null,
    expected_move_pct:
      typeof body.expected_move_pct === "number" &&
      Number.isFinite(body.expected_move_pct) &&
      body.expected_move_pct > 0
        ? body.expected_move_pct
        : null,
    guidance_notes: body.guidance_notes ?? null,
    notes: body.notes ?? null,
    extra_metrics_json: extraMetricsJson,
  });

  return Response.json({ success: true, ...result, ...(recompile ? { recompiled: recompile } : {}) });
}

export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const id = Number(url.searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return Response.json(
      { success: false, error: "Query param 'id' must be a positive integer." },
      { status: 400 },
    );
  }
  const { deleted, recompile } = deleteBogeyWithRecompile(db, id);
  return Response.json({ success: true, deleted, ...(recompile ? { recompiled: recompile } : {}) });
}
```

The `recompileLivePrint` helper and the raw `SELECT id, extra_metrics_json` query printed in the original Step 3b are DELETED — the helper moved into the mutation module (that is what makes it transactional) and the raw query is unnecessary now that `getBogeysForEvent` returns the column.

**Interfaces (replacing the four wire-shape comments):**

```ts
// lib/mutations/earnings-bogeys.ts
export interface UpsertBogeyInput { /* …existing fields… */ extra_metrics_json?: string | null }
export interface UpsertBogeyResult { id: number; created: boolean; skipped?: boolean }
export function saveBogeyWithRecompile(db, input): { result: UpsertBogeyResult; recompile: RecompileReport | null };
export function deleteBogeyWithRecompile(db, id): { deleted: boolean; recompile: RecompileReport | null };

// GET /api/earnings/bogeys?eventId=NN   (envelope ADDITIVE — `bogeys` keeps its key)
{ success: true;
  bogeys: Array<EarningsBogey & { extraMetrics: ExtraMetricSpec[]; extraMetricErrors: string[] }>;
  extraMetricConflicts: Array<{ id: string; fields: string[] }> }
// 400 { success: false, error: string }

// POST /api/earnings/bogeys   body gains `extra_metrics_json?: string | null`
// 400 { success: false, error }   — parseExtraMetrics errors joined with " "
// 200 { success: true, id, created, skipped?, recompiled?: RecompileReport }

// DELETE /api/earnings/bogeys?id=NN
// 200 { success: true, deleted: boolean, recompiled?: RecompileReport }
```

**(e) Step 3c amendments — the modal.** Three changes to what Step 3c prints.

1. **Serialiser (Codex 3).** `parseLargeUSD` was applied to EVERY unit, so `27.5%` on a `pct` row became `null` and was saved as "no bogey". The modal now parses nothing: it hands the trimmed text to the shared parser, which reads it against the row's own unit. Drop the `parseLargeUSD` import if nothing else in the file uses it.

```tsx
/** The editor holds STRINGS while typing and ships strings; parseExtraMetrics
 *  reads each one against its row's unit (usd takes the parseLargeUSD grammar,
 *  pct takes a decimal with an optional %, and neither is ever coerced). Doing
 *  the parsing here would have to duplicate that table, and did — wrongly. */
function extraRowsToJson(rows: ExtraRow[]): string | null {
  if (rows.length === 0) return null;
  return JSON.stringify(rows.map((r) => ({
    id: r.id,
    label: r.label.trim(),
    definition: r.definition.trim(),
    unit: r.unit,
    kind: r.kind,
    period: r.period,
    basis: r.basis,
    consensus: r.consensus.trim() === "" ? null : r.consensus.trim(),
    whisper: r.whisper.trim() === "" ? null : r.whisper.trim(),
  })));
}
```

2. **Hydration + reuse (Codex 1, R-F2).** The load effect stores the rows, and an effect keyed on the typed `source_label` fills the editor from the matching sheet ONCE, so re-saving a sheet keeps its ids. A `copy id` button plus a paste box on the add control is how the SAME id lands on a second sheet (which is what makes a cross-sheet conflict — and its resolution — reachable at all, and what E2E step 9 uses).

```tsx
const [existing, setExisting] = useState<Array<{ id: number; source_label: string | null; extraMetrics: ExtraMetricSpec[] }>>([]);
const [reuseId, setReuseId] = useState("");
const [copiedId, setCopiedId] = useState<string | null>(null);
const hydratedLabelRef = useRef<string | null>(null);

// In the load effect (`:71-124`), beside setConflicts:
//   setExisting(bogeysData.bogeys?.map((b) => ({ id: b.id, source_label: b.source_label, extraMetrics: b.extraMetrics ?? [] })) ?? []);

/** Editing an existing sheet must not re-mint its ids: a new id retires the
 *  live line and starts a fresh one, losing its continuity. Hydrate ONCE per
 *  label so the desk's own edits are never overwritten mid-typing. */
useEffect(() => {
  const label = (form.source_label ?? "").trim();
  if (hydratedLabelRef.current === label) return;
  const match = existing.find((b) => (b.source_label ?? "").trim() === label);
  if (!match) return;
  hydratedLabelRef.current = label;
  setExtraRows(match.extraMetrics.map((s) => ({
    id: s.id,
    label: s.label,
    definition: s.definition,
    unit: s.unit,
    kind: s.kind,
    period: s.period,
    basis: s.basis,
    consensus: s.consensus === null || s.consensus === undefined ? "" : String(s.consensus),
    whisper: s.whisper === null || s.whisper === undefined ? "" : String(s.whisper),
  })));
}, [form.source_label, existing]);

/** The id is minted at add-row time and immutable after that (M-F8). A pasted
 *  id is how the desk points a SECOND sheet at the same metric — the compiler
 *  then requires the two to agree on unit/kind/period/basis, which is the whole
 *  point of the conflict banner. */
function addExtraRow() {
  const pasted = reuseId.trim().toLowerCase();
  const id = isUuidV4(pasted) ? pasted : crypto.randomUUID();
  setReuseId("");
  setExtraRows((rows) => [...rows, {
    id, label: "", definition: "",
    unit: "usd", kind: "point", period: "Q", basis: "na", consensus: "", whisper: "",
  }]);
}

async function copyId(id: string) {
  try {
    await navigator.clipboard.writeText(id);
    setCopiedId(id);
  } catch {
    // A browser that refuses clipboard access is not a failure worth a modal —
    // the id is already on screen and selectable. Say so instead of nothing.
    setCopiedId(null);
    setExtraErrors([`Could not reach the clipboard — select the id (${id}) and copy it by hand.`]);
  }
}
```

Add `isUuidV4` and `type ExtraMetricSpec` to the `@/lib/print-watch/extra-metrics` import, and `useRef` to the React import. The header control becomes the pasted-id input plus the button:

```tsx
                <span className="flex items-center gap-2">
                  <input
                    type="text"
                    value={reuseId}
                    onChange={(e) => setReuseId(e.target.value)}
                    placeholder="paste an id to reuse (optional)"
                    className="w-[15rem] max-w-full bg-raised border border-edge rounded px-2 py-0.5 font-mono text-[10px] text-ink-dim focus:outline-none focus:border-gold"
                  />
                  <button
                    type="button"
                    onClick={addExtraRow}
                    className="text-[11px] text-ink-dim hover:text-gold border border-edge rounded px-2 py-0.5"
                  >
                    + add metric
                  </button>
                </span>
```

and the per-row id line gains the copy control (the input itself stays `readOnly`):

```tsx
                    <span className="flex items-center gap-2">
                      <input type="text" value={row.id} readOnly
                        title="Immutable id — the sheet line is keyed on it"
                        className="bg-transparent font-mono text-[10px] text-ink-faint w-[19rem] max-w-full" />
                      <button type="button" onClick={() => void copyId(row.id)}
                        className="text-[10px] text-ink-faint hover:text-gold underline">
                        {copiedId === row.id ? "copied" : "copy id"}
                      </button>
                    </span>
```

3. **Envelope (Codex 13).** The load effect and `save()` now check `data.success` as well as `res.ok`, and render `data.error` verbatim on a failure — the project's mutating-handler rule, and the reason the envelope became additive rather than replacing the keys the modal already reads.

**(f) Tests.** ADD to `tests/api/earnings-bogeys-extra-metrics.test.ts`; the three original POST cases and the GET case stand, with `expect(await bad.json())` becoming `{ success: false, error: "Metric 1: id must be a full uuid (v4)." }` and `body.recompiled` reached through the same envelope.

```ts
describe("extra-metric identity is the id: add + remove, never an edit (R-F2)", () => {
  it("dropping id A while adding id B retires A's evidenced line and compiles B", async () => {
    const { POST, GET } = await import("@/app/api/earnings/bogeys/route");
    const eventId = seedEvent();
    db.prepare(
      `INSERT INTO print_watch_prints (event_id, symbol, event_date, state) VALUES (?, 'XMPL1', '2026-09-10', 'acquired')`,
    ).run(eventId);

    const save = (extra: unknown[]) =>
      POST(new Request("http://localhost/api/earnings/bogeys", {
        method: "POST",
        body: JSON.stringify({ event_id: eventId, source_label: "Sheet A", extra_metrics_json: JSON.stringify(extra) }),
      }));

    await save([metric()]);
    // The desk accepted a reading against A's definition.
    db.prepare(`UPDATE print_watch_lines SET state = 'accepted', value = 275000000 WHERE metric_id = ?`).run(`x_${A}_Q`);

    const B = "0c9e2d71-4a5b-4c6d-9e8f-1a2b3c4d5e6f";
    const res = await save([metric({ id: B, label: "Net new ARR (re-minted)" })]);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.recompiled.retired).toEqual([`x_${A}_Q~retired~0`]);
    expect(body.recompiled.added).toEqual([`x_${B}_Q`]);

    const rows = db.prepare(`SELECT metric_id, state, value FROM print_watch_lines ORDER BY metric_id`).all() as
      Array<{ metric_id: string; state: string; value: number | null }>;
    const retired = rows.find((r) => r.metric_id === `x_${A}_Q~retired~0`)!;
    expect(retired.state).toBe("retired");
    expect(retired.value).toBe(275_000_000);      // the reading survives a re-mint
    expect(rows.find((r) => r.metric_id === `x_${B}_Q`)!.state).toBe("pending");

    // …and the GET hands the surviving id back so the modal can preserve it.
    const read = await (await GET(new Request(`http://localhost/api/earnings/bogeys?eventId=${eventId}`))).json();
    expect(read.bogeys[0].extraMetrics.map((s: { id: string }) => s.id)).toEqual([B]);
  });
});

describe("the bogey write and the recompile are ONE transaction (Codex 6)", () => {
  it("a throwing recompile rolls the bogey write back", async () => {
    const { saveBogeyWithRecompile } = await import("@/lib/mutations/earnings-bogeys");
    const eventId = seedEvent();
    db.prepare(
      `INSERT INTO print_watch_prints (event_id, symbol, event_date, state) VALUES (?, 'XMPL1', '2026-09-10', 'acquired')`,
    ).run(eventId);
    // A print row whose FK target the recompile's INSERT cannot satisfy is hard
    // to fake honestly, so break the sheet table for the duration instead: the
    // point is that ANY throw inside the recompile unwinds the outer write.
    db.exec(`DROP TABLE print_watch_lines`);
    expect(() =>
      saveBogeyWithRecompile(db, { event_id: eventId, source: "manual", source_label: "Sheet A", eps_consensus: 0.46 }),
    ).toThrow();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM earnings_bogeys`).get()).toEqual({ n: 0 });
  });
});

describe("the GET republishes each row's stored specs (Codex 1)", () => {
  it("returns parsed specs with their stored ids, and reports an unreadable value instead of hiding it", async () => {
    const { GET } = await import("@/app/api/earnings/bogeys/route");
    const eventId = seedEvent();
    const ins = db.prepare(
      `INSERT INTO earnings_bogeys (event_id, source, source_label, extra_metrics_json) VALUES (?, 'manual', ?, ?)`,
    );
    ins.run(eventId, "A", JSON.stringify([metric()]));
    ins.run(eventId, "B", "{not json");
    const body = await (await GET(new Request(`http://localhost/api/earnings/bogeys?eventId=${eventId}`))).json();
    const a = body.bogeys.find((b: { source_label: string }) => b.source_label === "A");
    const b = body.bogeys.find((x: { source_label: string }) => x.source_label === "B");
    expect(a.extraMetrics.map((s: { id: string }) => s.id)).toEqual([A]);
    expect(a.extraMetricErrors).toEqual([]);
    expect(b.extraMetrics).toEqual([]);
    expect(b.extraMetricErrors).toEqual(["Extra metrics must be valid JSON."]);
  });
});
```

And ADD to `tests/dashboard/bogeys-edit-modal-extra-metrics.test.ts`:

```ts
describe("BogeysEditModal — id identity and the shared parser (Codex round 1)", () => {
  it("hydrates stored specs instead of re-minting their ids", () => {
    expect(src).toMatch(/extraMetrics/);
    expect(src).toMatch(/hydratedLabelRef/);
  });
  it("offers copy-id and accepts a pasted id at ADD time only (the id input stays readOnly)", () => {
    expect(src).toMatch(/copy id/);
    expect(src).toMatch(/isUuidV4\(/);
    expect(src).toMatch(/readOnly/);
  });
  it("ships raw strings and lets the shared parser read them against the unit", () => {
    expect(src).not.toMatch(/parseLargeUSD\(r\./);
    expect(src).toMatch(/consensus: r\.consensus\.trim\(\) === "" \? null : r\.consensus\.trim\(\)/);
  });
  it("checks the envelope's success flag, not just res.ok", () => {
    expect(src).toMatch(/data\??\.success/);
  });
  it("says something honest when the clipboard is refused", () => {
    expect(src).toMatch(/copy it by hand/);
  });
});
```

The commit pathspec in Step 5 gains `lib/queries/earnings-bogeys.ts`.

- [ ] **Step 1: Write the failing tests**

`tests/repo/bogey-content-lists-agree.test.ts` (closes `docs/plans/TODO.md:81`):

```ts
/**
 * Repo guard, slice F (M-F20). `CONTENT_COLUMNS` (lib/mutations/earnings-bogeys.ts)
 * drives hasAnyContent + the preserve-mode COALESCE; `BOGEY_CONTENT`
 * (lib/earnings/event-merge.ts) drives the collision SET list. They are
 * deliberately NOT merged — they mean different things and event-merge also
 * carries BOGEY_PROVENANCE — but a content column the upsert knows about and
 * the merge does not would be silently destroyed on every (source, source_label)
 * collision. This pins containment in the direction that can lose data.
 */
import { describe, it, expect } from "vitest";
import { BOGEY_CONTENT } from "@/lib/earnings/event-merge";
import { CONTENT_COLUMNS } from "@/lib/mutations/earnings-bogeys";

describe("bogey content column lists", () => {
  it("every upsert content column is also carried by the merge", () => {
    const missing = CONTENT_COLUMNS.filter((c) => !(BOGEY_CONTENT as readonly string[]).includes(c));
    expect(missing).toEqual([]);
  });
  it("extra_metrics_json is in both (slice F)", () => {
    expect(CONTENT_COLUMNS as readonly string[]).toContain("extra_metrics_json");
    expect(BOGEY_CONTENT as readonly string[]).toContain("extra_metrics_json");
  });
});
```

`tests/api/earnings-bogeys-extra-metrics.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

const A = "5b7a1f42-9c3e-4d18-8f6a-2e0b91c7d4a3";
const metric = (o: Record<string, unknown> = {}) => ({
  id: A, label: "Net new ARR", definition: "Sequential change in ARR.",
  unit: "usd", kind: "point", period: "Q", basis: "na", ...o,
});

let db: Database.Database;
vi.mock("@/lib/db", () => ({ get db() { return db; } }));

function seedEvent(): number {
  db.prepare(
    `INSERT INTO calendar_events (event_date, event_type, title, symbol, source)
     VALUES ('2026-09-10','earnings','XMPL1 Q3','XMPL1','manual')`,
  ).run();
  return Number((db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id);
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  vi.resetModules();
});

describe("POST /api/earnings/bogeys — extra_metrics_json", () => {
  it("stores a valid array and reports every parse error on an invalid one", async () => {
    const { POST } = await import("@/app/api/earnings/bogeys/route");
    const eventId = seedEvent();

    const ok = await POST(new Request("http://localhost/api/earnings/bogeys", {
      method: "POST",
      body: JSON.stringify({ event_id: eventId, source_label: "Sheet A", extra_metrics_json: JSON.stringify([metric()]) }),
    }));
    expect(ok.status).toBe(200);
    const stored = db.prepare(`SELECT extra_metrics_json FROM earnings_bogeys WHERE event_id = ?`).get(eventId) as { extra_metrics_json: string };
    expect(JSON.parse(stored.extra_metrics_json)[0].id).toBe(A);

    const bad = await POST(new Request("http://localhost/api/earnings/bogeys", {
      method: "POST",
      body: JSON.stringify({ event_id: eventId, source_label: "Sheet B", extra_metrics_json: JSON.stringify([{ ...metric(), id: "nope" }]) }),
    }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "Metric 1: id must be a full uuid (v4)." });
  });

  it("recompiles the event's live print after the write and says what changed", async () => {
    const { POST } = await import("@/app/api/earnings/bogeys/route");
    const eventId = seedEvent();
    db.prepare(
      `INSERT INTO print_watch_prints (event_id, symbol, event_date, state) VALUES (?, 'XMPL1', '2026-09-10', 'window_open')`,
    ).run(eventId);

    const res = await POST(new Request("http://localhost/api/earnings/bogeys", {
      method: "POST",
      body: JSON.stringify({ event_id: eventId, source_label: "Sheet A", eps_consensus: 0.46, extra_metrics_json: JSON.stringify([metric()]) }),
    }));
    const body = await res.json();
    expect(body.recompiled.added).toContain(`x_${A}_Q`);
    const line = db.prepare(`SELECT state FROM print_watch_lines WHERE metric_id = ?`).get(`x_${A}_Q`) as { state: string };
    expect(line.state).toBe("pending");
  });

  it("does not recompile an expired print", async () => {
    const { POST } = await import("@/app/api/earnings/bogeys/route");
    const eventId = seedEvent();
    db.prepare(
      `INSERT INTO print_watch_prints (event_id, symbol, event_date, state) VALUES (?, 'XMPL1', '2026-09-10', 'expired')`,
    ).run(eventId);
    const res = await POST(new Request("http://localhost/api/earnings/bogeys", {
      method: "POST",
      body: JSON.stringify({ event_id: eventId, source_label: "Sheet A", extra_metrics_json: JSON.stringify([metric()]) }),
    }));
    expect((await res.json()).recompiled).toBeUndefined();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM print_watch_lines`).get()).toEqual({ n: 0 });
  });
});

describe("GET /api/earnings/bogeys — extraMetricConflicts", () => {
  it("names the id and the disagreeing fields when two rows disagree, and is empty otherwise", async () => {
    const { GET } = await import("@/app/api/earnings/bogeys/route");
    const eventId = seedEvent();
    const ins = db.prepare(
      `INSERT INTO earnings_bogeys (event_id, source, source_label, extra_metrics_json) VALUES (?, 'manual', ?, ?)`,
    );
    ins.run(eventId, "A", JSON.stringify([metric()]));
    const clean = await (await GET(new Request(`http://localhost/api/earnings/bogeys?eventId=${eventId}`))).json();
    expect(clean.extraMetricConflicts).toEqual([]);

    ins.run(eventId, "B", JSON.stringify([metric({ unit: "pct", kind: "range" })]));
    const dirty = await (await GET(new Request(`http://localhost/api/earnings/bogeys?eventId=${eventId}`))).json();
    expect(dirty.extraMetricConflicts).toEqual([{ id: A, fields: ["kind", "unit"] }]);
  });
});

describe("DELETE /api/earnings/bogeys", () => {
  it("recompiles after removing a sheet, retiring a line that had a value", async () => {
    const { DELETE } = await import("@/app/api/earnings/bogeys/route");
    const eventId = seedEvent();
    db.prepare(
      `INSERT INTO earnings_bogeys (event_id, source, source_label, extra_metrics_json) VALUES (?, 'manual', 'A', ?)`,
    ).run(eventId, JSON.stringify([metric()]));
    const bogeyId = Number((db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id);
    db.prepare(
      `INSERT INTO print_watch_prints (event_id, symbol, event_date, state) VALUES (?, 'XMPL1', '2026-09-10', 'acquired')`,
    ).run(eventId);
    const printId = Number((db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id);
    db.prepare(
      `INSERT INTO print_watch_lines (print_id, metric_id, contract_json, state, value, candidates_json)
       VALUES (?, ?, ?, 'accepted', 275000000, '[]')`,
    ).run(printId, `x_${A}_Q`, JSON.stringify({ metric_id: `x_${A}_Q`, label: "Net new ARR", definition: "d", basis: "na", period: "Q", currency: "USD", unit: "usd", kind: "point", segment: null }));

    const res = await DELETE(new Request(`http://localhost/api/earnings/bogeys?id=${bogeyId}`, { method: "DELETE" }));
    const body = await res.json();
    expect(body.deleted).toBe(true);
    expect(body.recompiled.retired).toEqual([`x_${A}_Q~retired~0`]);
  });
});
```

`tests/dashboard/bogeys-edit-modal-extra-metrics.test.ts` (source pins plus the pure round-trip — the modal has no render-testable shell without jsdom because it portals into `document.body`):

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseExtraMetrics } from "@/lib/print-watch/extra-metrics";

const src = readFileSync("app/dashboard/today/BogeysEditModal.tsx", "utf8");

describe("BogeysEditModal — extra metrics editor", () => {
  it("mints the id client-side with crypto.randomUUID and never lets the user edit it", () => {
    expect(src).toMatch(/crypto\.randomUUID\(\)/);
    expect(src).toMatch(/readOnly/);
  });
  it("validates with the SAME parser the route validates with, before POSTing", () => {
    expect(src).toMatch(/from "@\/lib\/print-watch\/extra-metrics"/);
    expect(src).toMatch(/parseExtraMetrics\(/);
  });
  it("sends extra_metrics_json in the save body", () => {
    expect(src).toMatch(/extra_metrics_json/);
  });
  it("renders a conflict banner from the GET response rather than inventing one", () => {
    expect(src).toMatch(/extraMetricConflicts/);
    expect(src).toMatch(/disagree on/);
  });
  it("checks res.ok AND the error field and never swallows a failure", () => {
    expect(src).not.toMatch(/catch\s*\{\s*\}/);
  });
  it("offers no caret affordance for the add/remove controls (project UI rule)", () => {
    expect(src).not.toMatch(/▾|▼/);
  });
});

describe("the editor's rows round-trip through the shared parser", () => {
  it("an editor row with empty numbers parses to nulls, not NaN", () => {
    const json = JSON.stringify([{
      id: "5b7a1f42-9c3e-4d18-8f6a-2e0b91c7d4a3", label: "Net new ARR", definition: "",
      unit: "usd", kind: "point", period: "Q", basis: "na", consensus: "", whisper: "",
    }]);
    expect(parseExtraMetrics(json)).toEqual({
      specs: [{
        id: "5b7a1f42-9c3e-4d18-8f6a-2e0b91c7d4a3", label: "Net new ARR", definition: "",
        unit: "usd", kind: "point", period: "Q", basis: "na", consensus: null, whisper: null,
      }],
      errors: [],
    });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/repo/bogey-content-lists-agree.test.ts tests/api/earnings-bogeys-extra-metrics.test.ts tests/dashboard/bogeys-edit-modal-extra-metrics.test.ts`
Expected: FAIL — `extra_metrics_json` is not in `CONTENT_COLUMNS`, the route has no `extraMetricConflicts`, the modal has no editor.

- [ ] **Step 3a: The mutation**

In `lib/mutations/earnings-bogeys.ts`:
- add to `UpsertBogeyInput`, after `notes`:
```ts
  /** Desk-defined extra metric lines (spec §4.7). Validated by the ROUTE
   *  through parseExtraMetrics before it reaches here; stored verbatim. */
  extra_metrics_json?: string | null;
```
- **export** `CONTENT_COLUMNS` (the guard test imports it) and add the column at the end so the SQL built from it stays stable:
```ts
export const CONTENT_COLUMNS = [
  "eps_consensus",
  "eps_whisper",
  "revenue_consensus_usd",
  "revenue_whisper_usd",
  "expected_move_pct",
  "eps_consensus_vendor",
  "segment_breakdown_json",
  "guidance_notes",
  "notes",
  "extra_metrics_json",
] as const;
```
- `INSERT_SQL` gains the column and one placeholder (18 columns, 18 `?` before `datetime('now')` — recount when editing):
```sql
INSERT INTO earnings_bogeys (
  event_id, source, source_label, source_url, raw_pdf_r2_key,
  research_document_id, research_article_id, eps_consensus, eps_whisper,
  revenue_consensus_usd, revenue_whisper_usd, expected_move_pct,
  eps_consensus_vendor,
  segment_breakdown_json, guidance_notes, notes, extra_metrics_json, uploaded_at,
  ai_extraction_model
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
```
- `OVERWRITE_SQL` gains `extra_metrics_json = excluded.extra_metrics_json,` next to `notes`. (`PRESERVE_SQL` is generated from `CONTENT_COLUMNS`, so it picks the column up automatically.)
- `normalizeTextContent` is applied to it in `upsertBogey`'s `normalized` object (an empty string must store NULL, not `""`), and `stmt.run(...)` gains `normalized.extra_metrics_json ?? null` in the position matching the SQL (immediately after `normalized.notes ?? null`).

- [ ] **Step 3b: The route**

`app/api/earnings/bogeys/route.ts`:

```ts
import { db } from "@/lib/db";
import { getBogeysForEvent } from "@/lib/queries/earnings-bogeys";
import { upsertBogey, deleteBogey } from "@/lib/mutations/earnings-bogeys";
import { parseExtraMetrics, detectExtraMetricConflicts } from "@/lib/print-watch/extra-metrics";
import { recompileContracts, type RecompileReport } from "@/lib/print-watch/recompile";
import { getPrintByEventId } from "@/lib/print-watch/store";

export const dynamic = "force-dynamic";

/** Recompile the event's live sheet after a bogey write. A print that is
 *  expired or disarmed is finished measuring — its sheet is the record of what
 *  was measured and is never re-derived. No print at all is the normal case. */
function recompileLivePrint(eventId: number): RecompileReport | undefined {
  const print = getPrintByEventId(db, eventId);
  if (!print || print.state === "expired" || print.state === "disarmed") return undefined;
  return recompileContracts(db, print.id);
}
```

GET keeps its shape and adds the conflicts (a PURE read — `detectExtraMetricConflicts` is pure and `getBogeysForEvent` already returns the rows; `extra_metrics_json` is NOT in `EarningsBogey`, so read it with one extra scoped query rather than widening the shared query type):

```ts
  const bogeys = getBogeysForEvent(db, eventId);
  const rawRows = db
    .prepare(`SELECT id, extra_metrics_json FROM earnings_bogeys WHERE event_id = ? ORDER BY id ASC`)
    .all(eventId) as Array<{ id: number; extra_metrics_json: string | null }>;
  const extraMetricConflicts = detectExtraMetricConflicts(
    rawRows.map((r) => ({ id: r.id, specs: parseExtraMetrics(r.extra_metrics_json).specs })),
  );
  return Response.json({ bogeys, extraMetricConflicts });
```

POST validates before writing and recompiles after:

```ts
  let extraMetricsJson: string | null = null;
  if (body.extra_metrics_json !== undefined && body.extra_metrics_json !== null) {
    if (typeof body.extra_metrics_json !== "string") {
      return Response.json({ error: "Body field 'extra_metrics_json' must be a JSON string." }, { status: 400 });
    }
    const { errors } = parseExtraMetrics(body.extra_metrics_json);
    if (errors.length > 0) return Response.json({ error: errors.join(" ") }, { status: 400 });
    extraMetricsJson = body.extra_metrics_json.trim() === "" ? null : body.extra_metrics_json;
  }

  const result = upsertBogey(db, { /* …existing fields… */, extra_metrics_json: extraMetricsJson });
  const recompiled = recompileLivePrint(body.event_id);
  return Response.json(recompiled ? { ...result, recompiled } : result);
```

DELETE must read the row's `event_id` BEFORE deleting it:

```ts
  const row = db.prepare(`SELECT event_id FROM earnings_bogeys WHERE id = ?`).get(id) as { event_id: number } | undefined;
  const ok = deleteBogey(db, id);
  if (!ok || !row) return Response.json({ deleted: ok });
  const recompiled = recompileLivePrint(row.event_id);
  return Response.json(recompiled ? { deleted: true, recompiled } : { deleted: true });
```

`ManualBogeyBody` gains `extra_metrics_json?: string | null;`.

- [ ] **Step 3c: The modal**

`app/dashboard/today/BogeysEditModal.tsx` — the editor is a sibling of the existing numeric grid inside the "Add manual bogeys" form, matching its `<Field>` + input styling (`:496-544`, `Field` at `:610-619`). Add to the imports:

```tsx
import {
  parseExtraMetrics,
  MAX_LABEL,
  MAX_DEFINITION,
  type ExtraMetricSpec,
} from "@/lib/print-watch/extra-metrics";
```

(`extra-metrics.ts` is client-safe by Task 1 — that is why the modal can validate with the route's own parser.)

State, alongside `form`:

```tsx
/** Editor rows are STRINGS while typing (numbers parse at save, exactly as the
 *  bogey numbers already do) and carry an immutable minted id. */
interface ExtraRow {
  id: string;
  label: string;
  definition: string;
  unit: ExtraMetricSpec["unit"];
  kind: ExtraMetricSpec["kind"];
  period: ExtraMetricSpec["period"];
  basis: ExtraMetricSpec["basis"];
  consensus: string;
  whisper: string;
}
const [extraRows, setExtraRows] = useState<ExtraRow[]>([]);
const [extraErrors, setExtraErrors] = useState<string[]>([]);
const [conflicts, setConflicts] = useState<Array<{ id: string; fields: string[] }>>([]);
```

The load effect (`:71-124`) stores the conflicts off the GET: `setConflicts(bogeysData.extraMetricConflicts ?? [])`. Reset `extraRows`/`extraErrors` with the rest of the form on open.

The serialiser + the pre-POST validation:

```tsx
function extraRowsToJson(rows: ExtraRow[]): string | null {
  if (rows.length === 0) return null;
  return JSON.stringify(rows.map((r) => ({
    id: r.id,
    label: r.label.trim(),
    definition: r.definition.trim(),
    unit: r.unit,
    kind: r.kind,
    period: r.period,
    basis: r.basis,
    consensus: r.consensus.trim() === "" ? null : parseLargeUSD(r.consensus),
    whisper: r.whisper.trim() === "" ? null : parseLargeUSD(r.whisper),
  })));
}
```

In `save()`, before the `apiFetch`:

```tsx
      const extra_metrics_json = extraRowsToJson(extraRows);
      const { errors } = parseExtraMetrics(extra_metrics_json);
      if (errors.length > 0) { setExtraErrors(errors); setSaving(false); return; }
      setExtraErrors([]);
```
and add `extra_metrics_json` to the POST body. The server re-validates — the client check is a fast, identical refusal, never the only one.

The markup (a `<Field>`-styled block; add-row uses `crypto.randomUUID()` and the id renders read-only so it is visibly the immutable key):

```tsx
            <div className="mt-4 border-t border-edge pt-3">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[11px] uppercase tracking-wider text-ink-faint">Extra metrics</span>
                <button
                  type="button"
                  onClick={() => setExtraRows((rows) => [...rows, {
                    id: crypto.randomUUID(), label: "", definition: "",
                    unit: "usd", kind: "point", period: "Q", basis: "na", consensus: "", whisper: "",
                  }])}
                  className="text-[11px] text-ink-dim hover:text-gold border border-edge rounded px-2 py-0.5"
                >
                  + add metric
                </button>
              </div>
              {conflicts.length > 0 && (
                <p className="mt-2 rounded border border-warn/40 bg-warn/10 px-2 py-1.5 text-[12px] text-warn">
                  {conflicts.map((c) => `${c.id.slice(0, 8)}… — sheets disagree on ${c.fields.join(" and ")}`).join(" · ")}
                  {" "}— no line is compiled for these until every sheet agrees.
                </p>
              )}
              {extraErrors.length > 0 && (
                <ul className="mt-2 text-[12px] text-down list-disc pl-4">
                  {extraErrors.map((e) => <li key={e}>{e}</li>)}
                </ul>
              )}
              {extraRows.map((row, i) => (
                <div key={row.id} className="mt-2 rounded border border-edge p-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-mono text-[10px] text-ink-faint" title="Immutable id — the sheet line is keyed on it">
                      <input type="text" value={row.id} readOnly className="bg-transparent text-ink-faint w-[19rem] max-w-full" />
                    </span>
                    <button
                      type="button"
                      onClick={() => setExtraRows((rows) => rows.filter((r) => r.id !== row.id))}
                      className="text-[11px] text-ink-faint hover:text-down"
                    >
                      remove
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-3 mt-1">
                    <Field label={`Label (max ${MAX_LABEL})`}>
                      <input type="text" maxLength={MAX_LABEL} value={row.label}
                        onChange={(e) => setExtraRows((rows) => rows.map((r, j) => j === i ? { ...r, label: e.target.value } : r))}
                        placeholder="Net new ARR"
                        className="w-full bg-raised border border-edge rounded px-2 py-1.5 text-[14px] font-mono text-ink focus:outline-none focus:border-gold" />
                    </Field>
                    <Field label="Unit">
                      <select value={row.unit}
                        onChange={(e) => setExtraRows((rows) => rows.map((r, j) => j === i ? { ...r, unit: e.target.value as ExtraRow["unit"] } : r))}
                        className="w-full bg-raised border border-edge rounded px-2 py-1.5 text-[14px] font-mono text-ink focus:outline-none focus:border-gold">
                        <option value="usd">usd</option><option value="per_share">per_share</option>
                        <option value="pct">pct</option><option value="count">count</option>
                      </select>
                    </Field>
                    <Field label="Kind">
                      <select value={row.kind}
                        onChange={(e) => setExtraRows((rows) => rows.map((r, j) => j === i ? { ...r, kind: e.target.value as ExtraRow["kind"] } : r))}
                        className="w-full bg-raised border border-edge rounded px-2 py-1.5 text-[14px] font-mono text-ink focus:outline-none focus:border-gold">
                        <option value="point">point</option><option value="range">range</option>
                      </select>
                    </Field>
                    <Field label="Period">
                      <select value={row.period}
                        onChange={(e) => setExtraRows((rows) => rows.map((r, j) => j === i ? { ...r, period: e.target.value as ExtraRow["period"] } : r))}
                        className="w-full bg-raised border border-edge rounded px-2 py-1.5 text-[14px] font-mono text-ink focus:outline-none focus:border-gold">
                        <option value="Q">Q</option><option value="NQ_guide">NQ_guide</option><option value="FY_guide">FY_guide</option>
                      </select>
                    </Field>
                    <Field label="Basis">
                      <select value={row.basis}
                        onChange={(e) => setExtraRows((rows) => rows.map((r, j) => j === i ? { ...r, basis: e.target.value as ExtraRow["basis"] } : r))}
                        className="w-full bg-raised border border-edge rounded px-2 py-1.5 text-[14px] font-mono text-ink focus:outline-none focus:border-gold">
                        <option value="na">na</option><option value="gaap">gaap</option><option value="non_gaap">non_gaap</option>
                      </select>
                    </Field>
                    <Field label="Consensus">
                      <input type="text" value={row.consensus}
                        onChange={(e) => setExtraRows((rows) => rows.map((r, j) => j === i ? { ...r, consensus: e.target.value } : r))}
                        placeholder="$300M"
                        className="w-full bg-raised border border-edge rounded px-2 py-1.5 text-[14px] font-mono text-ink focus:outline-none focus:border-gold" />
                    </Field>
                    <Field label="Whisper">
                      <input type="text" value={row.whisper}
                        onChange={(e) => setExtraRows((rows) => rows.map((r, j) => j === i ? { ...r, whisper: e.target.value } : r))}
                        placeholder="$310M"
                        className="w-full bg-raised border border-edge rounded px-2 py-1.5 text-[14px] font-mono text-ink focus:outline-none focus:border-gold" />
                    </Field>
                  </div>
                  <Field label={`Definition (max ${MAX_DEFINITION})`}>
                    <textarea rows={2} maxLength={MAX_DEFINITION} value={row.definition}
                      onChange={(e) => setExtraRows((rows) => rows.map((r, j) => j === i ? { ...r, definition: e.target.value } : r))}
                      placeholder="Sequential change in annual recurring revenue."
                      className="w-full bg-raised border border-edge rounded px-2 py-1.5 text-[13px] text-ink focus:outline-none focus:border-gold" />
                  </Field>
                </div>
              ))}
            </div>
```

The banner copy the test pins is the phrase `disagree on`; keep it verbatim.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/repo/ tests/api/earnings-bogeys-extra-metrics.test.ts tests/dashboard/bogeys-edit-modal-extra-metrics.test.ts tests/mutations/ tests/earnings/
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run build
```
Expected: PASS; `npm run build` clean (this is the wave's client-boundary gate — the modal now imports `@/lib/print-watch/extra-metrics`, whose only import is `./types`).

- [ ] **Step 5: Commit**

```bash
cat > /tmp/msg-f4.txt <<'MSG'
feat(earnings): desk-defined extra metric lines end to end

Bogey upsert carries extra_metrics_json (and CONTENT_COLUMNS now covers it, so
a newsletter re-scan preserves it); the route validates with the same parser the
modal validates with, reports cross-sheet conflicts on GET, and recompiles the
event's live print after every write and delete. Closes the "single-source the
bogey content columns" TODO with a containment guard rather than a merge.
MSG
git commit lib/mutations/earnings-bogeys.ts lib/queries/earnings-bogeys.ts app/api/earnings/bogeys/route.ts app/dashboard/today/BogeysEditModal.tsx tests/api/earnings-bogeys-extra-metrics.test.ts tests/dashboard/bogeys-edit-modal-extra-metrics.test.ts tests/repo/bogey-content-lists-agree.test.ts -F /tmp/msg-f4.txt
```

---
### Task 5: `buildCockpitPayload` widened to the Hub's week (M-F5)

**Files:**
- Modify: `lib/queries/earnings-cockpit.ts` — `CockpitRow` (`:34-63`), `CockpitPayload` (`:59-65`), `buildCockpitPayload` (`:91-266`)
- Modify: `app/api/earnings/cockpit/route.ts` — both handlers take `?weekOf=`
- Test: `tests/queries/earnings-cockpit.test.ts` (EXISTS, 243 lines — extend)

**Interfaces:**
- Consumes: `todayET`, `addDays` (already imported at `earnings-cockpit.ts:23`), `resolveWeekOfParam` (`lib/calendar/date-utils.ts:188`).
- Produces:

```ts
export interface CockpitRow { /* …every existing field… */ }   // unchanged; eventDate already present
export interface CockpitPayload {
  generatedAt: string;
  nextRelease: { eventId: number; symbol: string; releaseInstant: string } | null;
  lanes: { bmo: CockpitRow[]; amc: CockpitRow[]; unknown: CockpitRow[] };   // TODAY only, unchanged
  carryover: CockpitRow[];                                                   // unchanged
  skippedRows: number;
  /** NEW — every row in the requested window, keyed by event id. With no
   *  `weekOf` this covers exactly today + yesterday, i.e. the same rows the
   *  lanes and carryover already hold. */
  rowsByEvent: Record<number, CockpitRow>;
}
export function buildCockpitPayload(
  db: Database.Database,
  now?: Date,
  opts?: { weekOf?: string },
): CockpitPayload;
```

#### Amendments (Codex round 1) — Task 5

Finding folded here: **10** (= session **F-S3**) — widening the payload without widening the intel walk leaves the rest of the week with no intel. This block ADDS a file to the task, ADDS one function replacement to Step 3, DELETES the "STOP and escalate" paragraph at the end of Step 3, and ADDS one test.

**Files (amended):** adds `lib/queries/earnings-intel.ts` (ownership extended, ADDITIVE — contract §6 F row) to the Modify list. E does not touch this file; slice D's edit to it (`getReportHistoryBefore`) is already merged and is untouched here.

**What the plan got wrong.** Step 3's closing paragraph told the implementer to CHECK whether `cockpitRowsToIntelEvents` reads lanes + carryover and to STOP and escalate if it does. It does — and so does `decorateCockpitIntel`, through the same private helper. So `rowsByEvent` alone would give the Hub a Thursday row with `intel: null` and no re-ensure until Thursday morning, which is exactly the "chips for the full week" the spec's §8 F-line asks for. The escalation is now resolved: F edits that ONE helper additively.

Replacement for `lib/queries/earnings-intel.ts:92-94`:

```ts
function allCockpitRows(payload: CockpitPayload): CockpitRow[] {
  const rows = [...payload.lanes.bmo, ...payload.lanes.amc, ...payload.lanes.unknown, ...payload.carryover];
  // Slice F: with `weekOf`, `rowsByEvent` covers the whole Hub week. Lanes are
  // TODAY only and carryover is yesterday only, so a Thursday row is in neither
  // — without this it would render with no implied move and no history, and
  // ensureIntelForEvents would never see it until its own day. Deduped by
  // eventId so a row that IS in a lane keeps its single identity. The field is
  // read defensively: payloads hand-built by older tests do not carry it.
  const extra = payload.rowsByEvent ? Object.values(payload.rowsByEvent) : [];
  const seen = new Set(rows.map((r) => r.eventId));
  for (const row of extra) {
    if (seen.has(row.eventId)) continue;
    seen.add(row.eventId);
    rows.push(row);
  }
  return rows;
}
```

Nothing else in the file changes. In particular `cockpitRowsToIntelEvents` keeps its post-release filter verbatim (`stages.released.state !== "released" && stages.actual === "pending"`) — the INVARIANT recorded above it, that a released event is never re-ensured because the pre-print straddle is the recap's priced-in anchor, still holds for every row the wider walk adds.

**DELETE** the paragraph in Step 3 beginning "**Check `cockpitRowsToIntelEvents`** (`lib/queries/earnings-intel.ts`) before finishing:" through "…otherwise leave intel scoped to today and record the residual." — it is superseded in full.

Add to `tests/queries/earnings-cockpit.test.ts` (or `tests/queries/earnings-intel.test.ts` if that file exists — either is a Task 5 claim):

```ts
describe("the week's intel walk covers rowsByEvent (slice F, Codex round 1 #10 / F-S3)", () => {
  it("decorates a Thursday row and offers it for re-ensure while it is unreleased", () => {
    seedEarnings(db, { symbol: "NVDA", date: "2026-07-08", time: "AMC" });
    const thursday = seedEarnings(db, { symbol: "JPM", date: "2026-07-09", time: "BMO" });
    const payload = buildCockpitPayload(db, NOW, { weekOf: "2026-07-06" });

    // It is in NEITHER a lane nor carryover — that is the whole point.
    expect(payload.lanes.bmo.concat(payload.lanes.amc, payload.lanes.unknown, payload.carryover)
      .some((r) => r.eventId === thursday)).toBe(false);

    expect(cockpitRowsToIntelEvents(payload).map((e) => e.id)).toContain(thursday);
    decorateCockpitIntel(db, payload);
    expect(payload.rowsByEvent[thursday].intel).not.toBeNull();
  });

  it("never lists a row twice when it is BOTH in a lane and in rowsByEvent", () => {
    const today = seedEarnings(db, { symbol: "NVDA", date: "2026-07-08", time: "AMC" });
    const payload = buildCockpitPayload(db, NOW, { weekOf: "2026-07-06" });
    const ids = cockpitRowsToIntelEvents(payload).map((e) => e.id);
    expect(ids.filter((id) => id === today)).toHaveLength(1);
  });
});
```

(seed whatever intel row `decorateCockpitIntel` reads — `getIntelForEvents` — so `intel` is non-null; the file's existing helpers already do this for today's rows.)

The commit pathspec in Step 5 gains `lib/queries/earnings-intel.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/queries/earnings-cockpit.test.ts` (the file already fixes `const NOW = new Date("2026-07-08T14:00:00Z")` — Wednesday 2026-07-08, 10:00 ET — and mocks `@/lib/compute/exposure`; reuse both):

```ts
describe("buildCockpitPayload — weekOf widening (slice F, M-F5)", () => {
  it("with no weekOf the payload is unchanged and rowsByEvent covers exactly today plus carryover", () => {
    // seed: one held reporter today, one held reporter on Thursday 2026-07-09
    const today = seedEarnings(db, { symbol: "NVDA", date: "2026-07-08", time: "AMC" });
    const thursday = seedEarnings(db, { symbol: "JPM", date: "2026-07-09", time: "BMO" });
    const p = buildCockpitPayload(db, NOW);
    expect(p.lanes.amc.map((r) => r.eventId)).toEqual([today]);
    expect(Object.keys(p.rowsByEvent).map(Number)).toEqual([today]);
    expect(p.rowsByEvent[thursday]).toBeUndefined();
  });

  it("with weekOf, a Thursday event is in rowsByEvent for the week but NOT in today's lanes", () => {
    const today = seedEarnings(db, { symbol: "NVDA", date: "2026-07-08", time: "AMC" });
    const thursday = seedEarnings(db, { symbol: "JPM", date: "2026-07-09", time: "BMO" });
    const p = buildCockpitPayload(db, NOW, { weekOf: "2026-07-06" });
    expect(p.lanes.bmo).toEqual([]);
    expect(p.lanes.amc.map((r) => r.eventId)).toEqual([today]);
    expect(Object.keys(p.rowsByEvent).map(Number).sort((a, b) => a - b)).toEqual([today, thursday].sort((a, b) => a - b));
    expect(p.rowsByEvent[thursday].eventDate).toBe("2026-07-09");
  });

  it("keeps yesterday's unfinished carryover even when weekOf starts after it", () => {
    const yesterday = seedEarnings(db, { symbol: "NVDA", date: "2026-07-07", time: "AMC" });
    const p = buildCockpitPayload(db, NOW, { weekOf: "2026-07-08" }); // a Wednesday-anchored window
    expect(p.carryover.map((r) => r.eventId)).toEqual([yesterday]);
    expect(p.rowsByEvent[yesterday]).toBeDefined();
  });

  it("nextRelease still looks only at today's rows, not the whole week", () => {
    seedEarnings(db, { symbol: "JPM", date: "2026-07-09", time: "BMO", releaseTime: "07:00" });
    const p = buildCockpitPayload(db, NOW, { weekOf: "2026-07-06" });
    expect(p.nextRelease).toBeNull();
  });
});
```

(`seedEarnings` is the file's existing insert helper — reuse whatever it is called there; if it inserts inline, factor the insert into a local helper first, in the same commit, without changing any existing assertion.)

Also extend `tests/api/` with a route-level check — add to whichever cockpit route test exists, or create `tests/api/earnings-cockpit-weekof.test.ts`:

```ts
it("GET and POST honour ?weekOf= and fall back to the current Monday on garbage", async () => {
  const { GET } = await import("@/app/api/earnings/cockpit/route");
  const ok = await GET(new Request("http://localhost/api/earnings/cockpit?weekOf=2026-07-08"));
  expect(ok.status).toBe(200);
  const junk = await GET(new Request("http://localhost/api/earnings/cockpit?weekOf=not-a-date"));
  expect(junk.status).toBe(200);              // resolveWeekOfParam never 400s
  expect((await junk.json()).success).toBe(true);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/queries/earnings-cockpit.test.ts`
Expected: FAIL — `rowsByEvent` is `undefined` and the third argument is ignored.

- [ ] **Step 3: Implement**

In `lib/queries/earnings-cockpit.ts`:

(a) add `rowsByEvent: Record<number, CockpitRow>;` to `CockpitPayload`.

(b) the signature and the window:

```ts
export function buildCockpitPayload(
  db: Database.Database,
  now: Date = new Date(),
  opts: { weekOf?: string } = {}
): CockpitPayload {
  const today = todayET(now);
  const yesterday = addDays(today, -1);

  // The window. Without weekOf this is exactly the historical two days. With
  // weekOf it is the Hub's seven days PLUS yesterday — carryover keeps its
  // meaning (yesterday's unfinished prints) even when the viewed week does not
  // contain yesterday, which is how a Monday morning still shows Sunday night.
  const windowDates = opts.weekOf
    ? Array.from(new Set([...Array.from({ length: 7 }, (_, i) => addDays(opts.weekOf!, i)), yesterday])).sort()
    : [today, yesterday];
  const placeholders = windowDates.map(() => "?").join(", ");
```

and the two `?` in the SQL become `${placeholders}`, with `.all(...windowDates)` instead of `.all(today, yesterday)`:

```ts
          WHERE event_date IN (${placeholders})
```

(c) after the lane split and before the return, build the map (rows are already `CockpitRow[]`):

```ts
  const rowsByEvent: Record<number, CockpitRow> = {};
  for (const row of rows) rowsByEvent[row.eventId] = row;
```

and add `rowsByEvent` to BOTH return statements (the early empty return at `:127-136` returns `rowsByEvent: {}`).

(d) `laneFor` is only consulted for `todayRows`, which are already filtered by `!r.carryover`. Add the day filter so a Thursday row can never land in a lane:

```ts
  const carryover = rows.filter((r) => r.carryover);
  const todayRows = rows.filter((r) => !r.carryover && r.eventDate === today);
```

That one clause is the whole "lanes stay today-only" guarantee; every existing test still passes because without `weekOf` every non-carryover row IS today.

(e) the carryover skip rule (`:184-189`) already keys on `r.event_date === yesterday`; leave it exactly as it is. A row that is neither today nor yesterday is `carryover: false` and simply never reaches a lane.

In `app/api/earnings/cockpit/route.ts`, both handlers take the request and resolve the param:

```ts
import { resolveWeekOfParam } from "@/lib/calendar/date-utils";

function weekOfFrom(request: Request): string | undefined {
  const raw = new URL(request.url).searchParams.get("weekOf");
  return raw === null ? undefined : resolveWeekOfParam(raw);
}

export async function GET(request: Request) {
  try {
    const payload = buildCockpitPayload(db, new Date(), { weekOf: weekOfFrom(request) });
    decorateCockpitIntel(db, payload);
    return Response.json({ success: true, data: payload });
  } catch (err) { /* …unchanged… */ }
}
```
POST is the same one-line change; its `ensureIntelForEvents(db, cockpitRowsToIntelEvents(payload))` call is untouched (a wider payload simply refreshes intel for the whole week, which is what the Hub wants — and it stays TTL-guarded at one refresh per event per 30 minutes).

**Check `cockpitRowsToIntelEvents`** (`lib/queries/earnings-intel.ts`) before finishing: if it reads `payload.lanes` + `payload.carryover` it now MISSES the rest of the week. It must read `Object.values(payload.rowsByEvent)` instead — but that function lives in a file slice D touched and F does not own. **If it needs the change, STOP and escalate**: the alternative that needs no edit is for the route to pass the union itself, so prefer `ensureIntelForEvents(db, cockpitRowsToIntelEvents({ ...payload, lanes: { bmo: Object.values(payload.rowsByEvent), amc: [], unknown: [] }, carryover: [] }))` only if the helper's shape allows it; otherwise leave intel scoped to today and record the residual.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/queries/earnings-cockpit.test.ts tests/earnings/ tests/api/ tests/repo/symbol-status-consumers.test.ts`
Expected: PASS — including every pre-existing cockpit assertion, unchanged.

- [ ] **Step 5: Commit**

```bash
cat > /tmp/msg-f5.txt <<'MSG'
feat(cockpit): widen buildCockpitPayload to the Hub's week

An optional weekOf takes the window to the seven Hub days plus yesterday, and a
new rowsByEvent map carries them; lanes and carryover keep their exact today-only
meaning so every existing consumer is untouched. The routes resolve the param
through resolveWeekOfParam, which snaps to a Monday and never 400s.
MSG
git commit lib/queries/earnings-cockpit.ts lib/queries/earnings-intel.ts app/api/earnings/cockpit/route.ts tests/queries/earnings-cockpit.test.ts tests/api/earnings-cockpit-weekof.test.ts -F /tmp/msg-f5.txt
```

---
### Task 6: The pure controller modules — `poll-controller.ts`, `expansion.ts`, `types.ts` (M-F3 mechanics, M-F6 state machine)

**Files:**
- Create: `app/dashboard/today/hub-live/types.ts`, `app/dashboard/today/hub-live/poll-controller.ts`, `app/dashboard/today/hub-live/expansion.ts`
- Test: `tests/dashboard/hub-live-poll-controller.test.ts`, `tests/dashboard/hub-live-expansion.test.ts`

**Interfaces:**
- Consumes: NOTHING from `lib/` except types it re-declares locally (M-F18) — these three files import no React and no application module, which is what makes them unit-testable without jsdom.
- Produces:

```ts
// app/dashboard/today/hub-live/types.ts — the WIRE shapes, re-declared client-side
export type PrintWatchStateWire =
  "scheduled" | "window_open" | "acquired" | "parsed" | "expired" | "disarmed";
export interface GoRequestWire {
  id: number;
  status: "queued" | "claimed" | "done" | "failed";
  attempts: number;
  requestedAt: string;
  result: Array<{ road: string; outcome: string; detail: string }> | null;
}
export interface PrintOutputsWire {
  printSheet: { enabled: boolean; reason: string | null };
  sendRecap: {
    enabled: boolean;
    reason: string | null;
    state: "unsent" | "in-flight" | "sent" | "sent-by-cloud" | "delivery-unknown";
    providerMessageId: string | null;
  };
}
export interface PrintStatusEntry {
  printId: number;
  eventId?: number;
  symbol: string;
  state: PrintWatchStateWire;
  sources: Record<string, string>;
  coverage: string[];
  lines: PrintWatchLineWire[];
  documents?: Record<number, string>;
  documentRoads?: Record<number, Array<{ kind: string; source: string; verdict: string }>>;
  forcedOpenAt?: string | null;
  windowExtendedUntil?: string | null;
  effectiveWindow?: { start: string; end: string } | null;
  goRequest?: GoRequestWire | null;
  read?: FirstPassReadDto | null;
  activeRead?: ActiveReadDto | null;
  lastAttempt?: LastAttemptDto | null;
  callouts?: CalloutView[];
  /** Slice E, contract §2. ABSENT on F's own branch — render nothing. */
  outputs?: PrintOutputsWire;
}
export interface PrepareStepWire {
  event_id: number; step: string;
  status: "pending" | "claimed" | "done" | "failed";
  input_fingerprint: string | null; attempts: number;
  last_error: string | null; updated_at: string;
}
export interface CockpitRowWire { /* mirrors CockpitRow — see the file */ }
export interface CockpitPayloadWire {
  generatedAt: string;
  nextRelease: { eventId: number; symbol: string; releaseInstant: string } | null;
  lanes: { bmo: CockpitRowWire[]; amc: CockpitRowWire[]; unknown: CockpitRowWire[] };
  carryover: CockpitRowWire[];
  skippedRows: number;
  rowsByEvent: Record<number, CockpitRowWire>;
}

// app/dashboard/today/hub-live/poll-controller.ts
export type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export interface StreamSpec<T> {
  name: string;
  /** Milliseconds until the NEXT run, computed from the freshest state. */
  intervalMs: () => number;
  /** One request. Rejects on abort; the controller swallows AbortError. */
  run: (signal: AbortSignal, fetchImpl: FetchImpl) => Promise<T>;
  /** Applied ONLY when the response's generation is still the newest. */
  onResult: (value: T) => void;
  onError?: (err: unknown) => void;
}
export interface PollController {
  start(): void;
  /** Abort every in-flight request and stop every timer. Idempotent. */
  pause(): void;
  /** One immediate run per stream, then the timers restart. Idempotent. */
  resume(): void;
  /** Fire one stream now, out of band (the onChanged path). */
  refresh(name: string): void;
  /** Fire every stream now. */
  refreshAll(): void;
  stop(): void;
  /** Test seam: the generation last ISSUED for a stream. */
  generationOf(name: string): number;
}
export function createPollController(opts: {
  streams: Array<StreamSpec<unknown>>;
  fetchImpl: FetchImpl;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
}): PollController;

// app/dashboard/today/hub-live/expansion.ts
export interface ExpansionSnapshot {
  printId: number;
  state: PrintWatchStateWire;
  forcedOpenAt: string | null;
  goRequestId: number | null;
}
export type ManualToggle = { printId: number; open: boolean } | null;
/** The ONLY expansion decision. `prev === null` is the first load. */
export function deriveExpansion(
  prev: ExpansionSnapshot | null,
  next: ExpansionSnapshot,
  manual: ManualToggle,
): boolean;
export function snapshotOf(entry: {
  printId: number; state: PrintWatchStateWire;
  forcedOpenAt?: string | null; goRequest?: { id: number } | null;
}): ExpansionSnapshot;
export const EXPANDED_KEY_PREFIX = "vgs:print-expanded:";
export function readManual(printId: number, storage?: Pick<Storage, "getItem">): boolean | null;
export function writeManual(printId: number, open: boolean, storage?: Pick<Storage, "setItem">): void;
```

#### Amendments (Codex round 1) — Task 6

Findings folded here: **7** (= **F-S2** — the cockpit stream needs to know WHY it is running), **8** (= **F-S1** — the open-state reducer must be pure and must see the PREVIOUS print id), **18** (the promised client-boundary guard was never defined), **F-S9** (`stop()` uses `this`). This block REPLACES `StreamSpec`/`PollController` and the controller body in Step 3, ADDS `nextOpenState` to `expansion.ts`, ADDS one repo test file, and ADDS tests to both existing test files.

**Files (amended):** adds `tests/repo/hub-live-client-boundary.test.ts` to the Test list.

**(a) The trigger (Codex 7 / F-S2).** A stream currently cannot tell a first run from a timer tick from a mutation re-fetch, which is why the cockpit wiring in Task 9 came out inverted. `run` gains a fourth kind of information — why it was called — and the controller learns that a run may decline to fetch at all.

```ts
export type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** WHY this run is happening. The cockpit stream is the reason this exists: a
 *  server-rendered payload means `start` should issue NO request, a mutation
 *  or a returning tab wants a cheap GET, and only the 60-second tick wants the
 *  POST that refreshes intel. */
export type StreamTrigger = "start" | "timer" | "refresh" | "resume";

export interface StreamSpec<T> {
  name: string;
  /** Milliseconds until the NEXT run, computed from the freshest state. */
  intervalMs: () => number;
  /** One request. Rejects on abort; the controller swallows AbortError.
   *  Returning `null` means "nothing to do" — `onResult` is NOT called. */
  run: (signal: AbortSignal, fetchImpl: FetchImpl, trigger: StreamTrigger) => Promise<T | null>;
  /** Applied ONLY when the response's generation is still the newest AND the
   *  run returned something. */
  onResult: (value: T) => void;
  onError?: (err: unknown) => void;
}
```

Replacement for `schedule`, `fire` and the returned object in Step 3's `createPollController` (everything above `clearTimer` is unchanged):

```ts
  function schedule(s: StreamState) {
    clearTimer(s);
    if (!running) return;
    s.timer = setT(() => {
      s.timer = null;
      void fire(s, "timer");
    }, s.spec.intervalMs());
  }

  async function fire(s: StreamState, trigger: StreamTrigger) {
    if (!running) return;
    // A new run supersedes whatever was in flight for this stream: abort it so
    // the socket closes, and stamp the generation the response must match.
    s.controller?.abort();
    const controller = new AbortController();
    s.controller = controller;
    s.generation += 1;
    const generation = s.generation;
    try {
      const value = await s.spec.run(controller.signal, opts.fetchImpl, trigger);
      // Three ways not to apply: a newer run was issued, this one was aborted,
      // or the run declined to fetch (null) and has nothing to say.
      if (!running || controller.signal.aborted || generation !== s.generation) return;
      if (value !== null && value !== undefined) s.spec.onResult(value);
    } catch (err) {
      if (!isAbort(err) && !controller.signal.aborted) s.spec.onError?.(err);
    } finally {
      if (s.controller === controller) s.controller = null;
      if (running && generation === s.generation) schedule(s);
    }
  }

  // F-S9: `pause` is captured as a closure so `stop()` never reaches for
  // `this` — a destructured `const { stop } = controller` would otherwise
  // throw at the call site rather than at the mistake.
  function pause() {
    running = false;
    for (const s of states.values()) {
      clearTimer(s);
      s.controller?.abort();
      s.controller = null;
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      for (const s of states.values()) void fire(s, "start");
    },
    pause,
    resume() {
      if (running) return;
      running = true;
      for (const s of states.values()) void fire(s, "resume");
    },
    refresh(name: string) {
      const s = states.get(name);
      if (s && running) void fire(s, "refresh");
    },
    refreshAll() {
      if (!running) return;
      for (const s of states.values()) void fire(s, "refresh");
    },
    stop() {
      pause();
      states.clear();
    },
    generationOf(name: string) {
      return states.get(name)?.generation ?? 0;
    },
  };
```

Tests to ADD to `tests/dashboard/hub-live-poll-controller.test.ts` (the seven existing cases stand; the `stream()` helper's `run` gains the third parameter):

```ts
describe("the trigger tells a stream WHY it is running (Codex round 1 #7 / F-S2)", () => {
  it("reports start, then timer, then refresh, then resume — in that order for the same stream", async () => {
    const triggers: string[] = [];
    const c = createPollController({
      streams: [stream({
        intervalMs: () => 1_000,
        run: async (_signal, _fetchImpl, trigger) => { triggers.push(trigger); return "x"; },
      })],
      fetchImpl: (async () => new Response("{}")) as FetchImpl,
    });
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    c.refresh("status");
    await vi.advanceTimersByTimeAsync(0);
    c.pause();
    c.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(triggers).toEqual(["start", "timer", "refresh", "resume"]);
    c.stop();
  });

  it("a run that returns null never reaches onResult, and still reschedules", async () => {
    const applied: string[] = [];
    const c = createPollController({
      streams: [stream({
        intervalMs: () => 1_000,
        run: async (_s, _f, trigger) => (trigger === "start" ? null : "later"),
        onResult: (v) => applied.push(v),
      })],
      fetchImpl: (async () => new Response("{}")) as FetchImpl,
    });
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(applied).toEqual([]);          // the SSR payload was already the freshest thing
    await vi.advanceTimersByTimeAsync(1_000);
    expect(applied).toEqual(["later"]);   // the timer still fired
    c.stop();
  });

  it("stop() works when it is destructured off the controller (F-S9)", () => {
    const c = createPollController({ streams: [stream()], fetchImpl: (async () => new Response("{}")) as FetchImpl });
    c.start();
    const { stop } = c;
    expect(() => stop()).not.toThrow();
  });
});
```

**(b) The open-state reducer (Codex 8 / F-S1).** Task 9's effect wrote `prevRef.current = next` and THEN compared print ids, so the comparison was always true and a re-homed row stayed open — contradicting `deriveExpansion`'s own "a different print id is a new subject" rule. The decision is extracted here as a pure function, and Task 9 calls it with the id captured BEFORE the ref is written.

ADD to `app/dashboard/today/hub-live/expansion.ts`, after `deriveExpansion`:

```ts
/**
 * The whole open/closed decision for one row, as data (Codex round 1 #8 /
 * F-S1). `deriveExpansion` answers "did something just happen that should open
 * this?"; this answers "so is it open?", which also has to respect what the row
 * was doing a moment ago — and must NOT carry that across a change of subject.
 *
 * `prevPrintId` is the id the row was showing BEFORE this payload, captured
 * before the caller overwrites its ref. When it differs from `next.printId`,
 * a date correction (or a merge) re-homed the row onto a different print: the
 * previous open state belonged to a different subject and is dropped, so only
 * a fresh decision can open the new one.
 *
 * Pure, so the correction case is testable without a DOM. This repo has no
 * jsdom and no React Testing Library, and none may be added — which is why
 * there is no mounted integration test for the wiring, only this reducer plus
 * a source pin in Task 9.
 */
export function nextOpenState(args: {
  was: boolean;
  decided: boolean;
  prevPrintId: number | null;
  next: ExpansionSnapshot;
  manual: ManualToggle;
}): boolean {
  const { was, decided, prevPrintId, next, manual } = args;
  if (manual && manual.printId === next.printId) return manual.open;
  if (prevPrintId !== next.printId) return decided;
  return decided || was;
}
```

Tests to ADD to `tests/dashboard/hub-live-expansion.test.ts` (import `nextOpenState`):

```ts
describe("nextOpenState — the correction case the effect used to get wrong (Codex 8 / F-S1)", () => {
  it("closes an open row when the print id changes, even into an opening state", () => {
    const next = snap({ printId: 2, state: "window_open" });
    const decided = deriveExpansion(snap({ printId: 1, state: "scheduled" }), next, null);
    expect(decided).toBe(false);                                   // different subject
    expect(nextOpenState({ was: true, decided, prevPrintId: 1, next, manual: null })).toBe(false);
  });
  it("then opens the NEW print on its own next transition", () => {
    const next = snap({ printId: 2, state: "acquired" });
    const decided = deriveExpansion(snap({ printId: 2, state: "window_open" }), next, null);
    expect(decided).toBe(true);
    expect(nextOpenState({ was: false, decided, prevPrintId: 2, next, manual: null })).toBe(true);
  });
  it("keeps an open row open across an uneventful poll of the SAME print", () => {
    const next = snap({ printId: 1, state: "acquired" });
    expect(nextOpenState({ was: true, decided: false, prevPrintId: 1, next, manual: null })).toBe(true);
  });
  it("lets a manual choice for THIS print win in both directions, and ignores one for another print", () => {
    const next = snap({ printId: 2, state: "acquired" });
    expect(nextOpenState({ was: true, decided: true, prevPrintId: 2, next, manual: { printId: 2, open: false } })).toBe(false);
    expect(nextOpenState({ was: false, decided: false, prevPrintId: 2, next, manual: { printId: 2, open: true } })).toBe(true);
    expect(nextOpenState({ was: true, decided: false, prevPrintId: 1, next, manual: { printId: 1, open: true } })).toBe(false);
  });
  it("a first sight (prevPrintId null) opens only on a fresh decision, which a first load never is", () => {
    const next = snap({ printId: 5, state: "window_open" });
    expect(deriveExpansion(null, next, null)).toBe(false);
    expect(nextOpenState({ was: false, decided: false, prevPrintId: null, next, manual: null })).toBe(false);
  });
});
```

**(c) The client-boundary guard (Codex 18).** M-F18 promised "F adds its own one-line guard test" and no task defined it. It is defined here, in Task 6, because Task 6 is the wave that creates the first `hub-live` files and W1 is the earliest point the rule can start being enforced.

`tests/repo/hub-live-client-boundary.test.ts`:

```ts
/**
 * Repo guard, slice F (M-F18, Codex round 1 #18). The existing
 * tests/repo/print-watch-import-boundaries.test.ts covers `lib/print-watch`;
 * it does NOT cover what a Today client file may pull out of `lib/earnings`,
 * `lib/queries`, `lib/digest` or `lib/calendar` — and `lib/earnings/cockpit-stages.ts`,
 * which F's chips need the TYPES from, value-imports @/lib/calendar/reaction-snapshot
 * and @/lib/calendar/enrichment-runner, which pull @stoqey/ib and half of lib/.
 * A value import from a "use client" file there does not fail a test; it fails
 * `next build` outright (R-D20).
 *
 * The rule: from a "use client" file under app/dashboard/today/**, any import
 * of those trees (or of a non-allowlisted lib/print-watch module) must be
 * `import type`. Newlines are collapsed first so a Prettier-wrapped import is
 * still one specifier.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(process.cwd(), "app", "dashboard", "today");

/** Kept in step with tests/repo/print-watch-import-boundaries.test.ts — the
 *  assertion below fails if the two lists drift apart. */
const CLIENT_SAFE = ["types", "first-pass-types", "reconcile", "first-pass-format", "extra-metrics"];

const TYPE_ONLY_TREES = ["@/lib/earnings/", "@/lib/queries/", "@/lib/digest/", "@/lib/calendar/"];

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

function mustBeTypeOnly(spec: string): boolean {
  if (TYPE_ONLY_TREES.some((t) => spec.startsWith(t))) return true;
  if (spec.startsWith("@/lib/print-watch/")) {
    const module = spec.slice("@/lib/print-watch/".length);
    return !CLIENT_SAFE.includes(module);
  }
  return false;
}

describe("Today's client files cross the server line with types only", () => {
  it("keeps the client-safe list in step with the print-watch boundary guard", () => {
    const sibling = fs.readFileSync("tests/repo/print-watch-import-boundaries.test.ts", "utf8");
    for (const name of CLIENT_SAFE) expect(sibling, `${name} missing from the sibling guard`).toContain(`"${name}"`);
  });

  it("never value-imports a server tree from a \"use client\" file", () => {
    const offenders: string[] = [];
    for (const file of walk(ROOT)) {
      const raw = fs.readFileSync(file, "utf8");
      if (!/^\s*["']use client["']/m.test(raw)) continue;
      const flat = raw.replace(/\n/g, " ");
      for (const m of flat.matchAll(/import\s+(type\s+)?([^"';]*?)from\s*["']([^"']+)["']/g)) {
        const isTypeOnly = Boolean(m[1]);
        const spec = m[3];
        if (mustBeTypeOnly(spec) && !isTypeOnly) {
          offenders.push(`${path.relative(process.cwd(), file)} -> ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
```

(`import { type X }` inline-type form is deliberately NOT accepted: the guard requires the statement to begin `import type`, which is the shape a text scan can trust and the shape M-F18 specifies.)

- [ ] **Step 1: Write the failing tests**

`tests/dashboard/hub-live-poll-controller.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPollController, type FetchImpl, type StreamSpec } from "@/app/dashboard/today/hub-live/poll-controller";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** A fetch stub whose per-call resolution is controlled by the test. */
function deferredFetch() {
  const calls: Array<{ url: string; signal: AbortSignal; resolve: (v: unknown) => void }> = [];
  const impl: FetchImpl = (input, init) =>
    new Promise((resolve) => {
      calls.push({ url: String(input), signal: init!.signal as AbortSignal, resolve: resolve as (v: unknown) => void });
    }) as Promise<Response>;
  return { impl, calls };
}

const stream = (over: Partial<StreamSpec<string>> = {}): StreamSpec<string> => ({
  name: "status",
  intervalMs: () => 2_000,
  run: async (signal, fetchImpl) => {
    const res = await fetchImpl("/api/print-watch/status", { signal });
    return String(res);
  },
  onResult: () => undefined,
  ...over,
});

describe("createPollController — generations", () => {
  it("DROPS a slow older response that lands after a newer one (spec §8 'generation-ordered responses')", async () => {
    const applied: string[] = [];
    const { impl, calls } = deferredFetch();
    const c = createPollController({ streams: [stream({ onResult: (v) => applied.push(v) })], fetchImpl: impl });
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);          // generation 1, in flight

    c.refresh("status");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(2);          // generation 2, in flight

    calls[1].resolve("new");                // the NEWER one lands first
    await vi.advanceTimersByTimeAsync(0);
    calls[0].resolve("old");                // the older one lands second
    await vi.advanceTimersByTimeAsync(0);

    expect(applied).toEqual(["new"]);       // "old" never reaches onResult
  });

  it("aborts the in-flight request on pause and applies nothing", async () => {
    const applied: string[] = [];
    const { impl, calls } = deferredFetch();
    const c = createPollController({ streams: [stream({ onResult: (v) => applied.push(v) })], fetchImpl: impl });
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls[0].signal.aborted).toBe(false);

    c.pause();
    expect(calls[0].signal.aborted).toBe(true);
    calls[0].resolve("late");
    await vi.advanceTimersByTimeAsync(0);
    expect(applied).toEqual([]);
  });

  it("resume issues exactly ONE immediate fetch per stream and restarts the timer", async () => {
    const { impl, calls } = deferredFetch();
    const c = createPollController({ streams: [stream(), stream({ name: "cockpit", intervalMs: () => 60_000 })], fetchImpl: impl });
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    calls.forEach((k) => k.resolve("x"));
    await vi.advanceTimersByTimeAsync(0);
    const before = calls.length;

    c.pause();
    c.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.length).toBe(before + 2);          // one per stream, not two per stream
  });

  it("follows the print state: the cadence is re-read from intervalMs on EVERY reschedule", async () => {
    let hot = false;
    const { impl, calls } = deferredFetch();
    const c = createPollController({
      streams: [stream({ intervalMs: () => (hot ? 2_000 : 30_000) })],
      fetchImpl: impl,
    });
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    calls[0].resolve("x");
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(calls).toHaveLength(1);                  // still cool
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    hot = true;
    calls[1].resolve("x");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toHaveLength(3);                  // now hot
  });

  it("two hot prints share ONE stream — the controller never forks a poll per print", async () => {
    const { impl, calls } = deferredFetch();
    const c = createPollController({ streams: [stream({ intervalMs: () => 2_000 })], fetchImpl: impl });
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    calls[0].resolve("two prints");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toHaveLength(2);                  // 2 ticks, 2 requests — not 4
  });

  it("uses recursive setTimeout, never setInterval, so a slow response cannot overlap itself", async () => {
    const spy = vi.spyOn(globalThis, "setInterval");
    const { impl, calls } = deferredFetch();
    const c = createPollController({ streams: [stream()], fetchImpl: impl });
    c.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(spy).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);                  // the first is still in flight; no second was scheduled
    c.stop();
    spy.mockRestore();
  });

  it("an error in one stream never stops the others and reports through onError", async () => {
    const errors: unknown[] = [];
    const applied: string[] = [];
    const c = createPollController({
      streams: [
        stream({ name: "bad", run: async () => { throw new Error("boom"); }, onError: (e) => errors.push(e) }),
        stream({ name: "good", run: async () => "ok", onResult: (v) => applied.push(v) }),
      ],
      fetchImpl: (async () => new Response("{}")) as FetchImpl,
    });
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    expect((errors[0] as Error).message).toBe("boom");
    expect(applied).toEqual(["ok"]);
    c.stop();
  });
});
```

`tests/dashboard/hub-live-expansion.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  deriveExpansion, snapshotOf, readManual, writeManual, EXPANDED_KEY_PREFIX,
  type ExpansionSnapshot,
} from "@/app/dashboard/today/hub-live/expansion";

const snap = (o: Partial<ExpansionSnapshot> = {}): ExpansionSnapshot =>
  ({ printId: 1, state: "scheduled", forcedOpenAt: null, goRequestId: null, ...o });

describe("deriveExpansion — the transition matrix (spec §4.6 'Auto-expansion is transition-based')", () => {
  const STATES = ["scheduled", "window_open", "acquired", "parsed", "expired", "disarmed"] as const;

  it("opens on ENTERING window_open or acquired, from any other state", () => {
    for (const from of STATES) {
      for (const to of ["window_open", "acquired"] as const) {
        const expected = from !== to;   // entering, not sitting in
        expect(deriveExpansion(snap({ state: from }), snap({ state: to }), null)).toBe(expected);
      }
    }
  });

  it("never opens on entering parsed, expired, disarmed or scheduled", () => {
    for (const from of STATES) {
      for (const to of ["parsed", "expired", "disarmed", "scheduled"] as const) {
        expect(deriveExpansion(snap({ state: from }), snap({ state: to }), null)).toBe(false);
      }
    }
  });

  it("does NOT auto-open on FIRST load, whatever the state — including parsed", () => {
    for (const to of STATES) {
      expect(deriveExpansion(null, snap({ state: to }), null)).toBe(false);
    }
  });

  it("opens when forcedOpenAt is newly set (the go press), and not when it merely persists", () => {
    expect(deriveExpansion(snap(), snap({ forcedOpenAt: "2026-09-10T20:05:00.000Z" }), null)).toBe(true);
    expect(
      deriveExpansion(
        snap({ forcedOpenAt: "2026-09-10T20:05:00.000Z" }),
        snap({ forcedOpenAt: "2026-09-10T20:05:00.000Z" }),
        null,
      ),
    ).toBe(false);
  });

  it("opens when a NEW go request id appears, and not when the same one is still running", () => {
    expect(deriveExpansion(snap(), snap({ goRequestId: 7 }), null)).toBe(true);
    expect(deriveExpansion(snap({ goRequestId: 7 }), snap({ goRequestId: 7 }), null)).toBe(false);
    expect(deriveExpansion(snap({ goRequestId: 7 }), snap({ goRequestId: 8 }), null)).toBe(true);
  });

  it("a manual toggle for THIS print overrides every transition, in both directions", () => {
    const opening = { prev: snap(), next: snap({ state: "window_open" }) };
    expect(deriveExpansion(opening.prev, opening.next, { printId: 1, open: false })).toBe(false);
    expect(deriveExpansion(snap({ state: "parsed" }), snap({ state: "parsed" }), { printId: 1, open: true })).toBe(true);
  });

  it("a manual toggle for a DIFFERENT print is ignored (the correction case)", () => {
    expect(deriveExpansion(snap(), snap({ state: "acquired" }), { printId: 99, open: false })).toBe(true);
  });

  it("a print id CHANGE (a date correction re-homed the print) is treated as a first load, not a transition", () => {
    // The old print's snapshot must never decide the new print's expansion.
    expect(deriveExpansion(snap({ printId: 1, state: "scheduled" }), snap({ printId: 2, state: "window_open" }), null)).toBe(false);
    // ...and a manual override keyed to the OLD print does not follow it.
    expect(deriveExpansion(snap({ printId: 1 }), snap({ printId: 2, state: "acquired" }), { printId: 1, open: true })).toBe(false);
  });
});

describe("snapshotOf", () => {
  it("normalises the optional wire fields to null", () => {
    expect(snapshotOf({ printId: 3, state: "parsed" })).toEqual({ printId: 3, state: "parsed", forcedOpenAt: null, goRequestId: null });
    expect(snapshotOf({ printId: 3, state: "parsed", forcedOpenAt: "t", goRequest: { id: 9 } }))
      .toEqual({ printId: 3, state: "parsed", forcedOpenAt: "t", goRequestId: 9 });
  });
});

describe("manual toggle persistence", () => {
  function fakeStorage(seed: Record<string, string> = {}) {
    const map = new Map(Object.entries(seed));
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => { map.set(k, v); },
      map,
    };
  }
  it("round-trips per print under vgs:print-expanded:<printId>", () => {
    const s = fakeStorage();
    expect(readManual(4, s)).toBeNull();
    writeManual(4, true, s);
    expect(s.map.get(`${EXPANDED_KEY_PREFIX}4`)).toBe("1");
    expect(readManual(4, s)).toBe(true);
    writeManual(4, false, s);
    expect(readManual(4, s)).toBe(false);
    expect(readManual(5, s)).toBeNull();
  });
  it("survives a storage that throws (private window, blocked site data)", () => {
    const throwing = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    };
    expect(readManual(4, throwing)).toBeNull();
    expect(() => writeManual(4, true, throwing)).not.toThrow();
  });
  it("treats an unrecognised stored value as no preference", () => {
    expect(readManual(4, fakeStorage({ [`${EXPANDED_KEY_PREFIX}4`]: "yes" }))).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/dashboard/hub-live-poll-controller.test.ts tests/dashboard/hub-live-expansion.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the modules**

`app/dashboard/today/hub-live/poll-controller.ts`:

```ts
/**
 * The Hub's polling mechanics, with no React in them (spec §4.6: "In-flight
 * requests carry a generation counter; older responses are dropped; requests
 * abort on unmount and when the tab is hidden, resume on visibility").
 *
 * Pure by design so it can be tested with fake timers and an injected fetch —
 * this repo has no jsdom and no React Testing Library, and none may be added.
 *
 * Recursive setTimeout, never setInterval: a status request that takes longer
 * than its own cadence must not overlap itself. That is the rule the print
 * panel already followed (PrintWatchPanel.tsx: "Recursive setTimeout (never
 * setInterval, to avoid overlap)") and it is kept verbatim here.
 */
export type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface StreamSpec<T> {
  name: string;
  intervalMs: () => number;
  run: (signal: AbortSignal, fetchImpl: FetchImpl) => Promise<T>;
  onResult: (value: T) => void;
  onError?: (err: unknown) => void;
}

export interface PollController {
  start(): void;
  pause(): void;
  resume(): void;
  refresh(name: string): void;
  refreshAll(): void;
  stop(): void;
  generationOf(name: string): number;
}

interface StreamState {
  spec: StreamSpec<unknown>;
  generation: number;
  timer: ReturnType<typeof setTimeout> | null;
  controller: AbortController | null;
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.message === "AbortError");
}

export function createPollController(opts: {
  streams: Array<StreamSpec<unknown>>;
  fetchImpl: FetchImpl;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
}): PollController {
  const setT = opts.setTimeoutImpl ?? setTimeout;
  const clearT = opts.clearTimeoutImpl ?? clearTimeout;
  const states = new Map<string, StreamState>(
    opts.streams.map((spec) => [spec.name, { spec, generation: 0, timer: null, controller: null }]),
  );
  let running = false;

  function clearTimer(s: StreamState) {
    if (s.timer !== null) {
      clearT(s.timer);
      s.timer = null;
    }
  }

  function schedule(s: StreamState) {
    clearTimer(s);
    if (!running) return;
    s.timer = setT(() => {
      s.timer = null;
      void fire(s);
    }, s.spec.intervalMs());
  }

  async function fire(s: StreamState) {
    if (!running) return;
    // A new run supersedes whatever was in flight for this stream: abort it so
    // the socket closes, and stamp the generation the response must match.
    s.controller?.abort();
    const controller = new AbortController();
    s.controller = controller;
    s.generation += 1;
    const generation = s.generation;
    try {
      const value = await s.spec.run(controller.signal, opts.fetchImpl);
      // Two ways to be stale: a newer run was issued, or this one was aborted.
      if (!running || controller.signal.aborted || generation !== s.generation) return;
      s.spec.onResult(value);
    } catch (err) {
      if (!isAbort(err) && !controller.signal.aborted) s.spec.onError?.(err);
    } finally {
      if (s.controller === controller) s.controller = null;
      if (running && generation === s.generation) schedule(s);
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      for (const s of states.values()) void fire(s);
    },
    pause() {
      running = false;
      for (const s of states.values()) {
        clearTimer(s);
        s.controller?.abort();
        s.controller = null;
      }
    },
    resume() {
      if (running) return;
      running = true;
      for (const s of states.values()) void fire(s);
    },
    refresh(name: string) {
      const s = states.get(name);
      if (s && running) void fire(s);
    },
    refreshAll() {
      if (!running) return;
      for (const s of states.values()) void fire(s);
    },
    stop() {
      this.pause();
      states.clear();
    },
    generationOf(name: string) {
      return states.get(name)?.generation ?? 0;
    },
  };
}
```

`app/dashboard/today/hub-live/expansion.ts`:

```ts
/**
 * When an armed Hub row's live-print expansion opens by itself (spec §4.6:
 * "Auto-expansion is transition-based (into window_open, acquired, forced, or a
 * new go request); parsed does not auto-expand on load; a manual toggle
 * overrides, remembered per print in localStorage").
 *
 * Everything here is pure. `prev === null` means FIRST LOAD, and a first load
 * never auto-opens — otherwise a page refresh at 16:20 would blow every
 * finished print open at once.
 */
import type { PrintWatchStateWire } from "./types";

export interface ExpansionSnapshot {
  printId: number;
  state: PrintWatchStateWire;
  forcedOpenAt: string | null;
  goRequestId: number | null;
}

export type ManualToggle = { printId: number; open: boolean } | null;

/** The states whose ARRIVAL means "this print is happening now". */
const OPENING_STATES: ReadonlySet<PrintWatchStateWire> = new Set(["window_open", "acquired"]);

export function snapshotOf(entry: {
  printId: number;
  state: PrintWatchStateWire;
  forcedOpenAt?: string | null;
  goRequest?: { id: number } | null;
}): ExpansionSnapshot {
  return {
    printId: entry.printId,
    state: entry.state,
    forcedOpenAt: entry.forcedOpenAt ?? null,
    goRequestId: entry.goRequest?.id ?? null,
  };
}

export function deriveExpansion(
  prev: ExpansionSnapshot | null,
  next: ExpansionSnapshot,
  manual: ManualToggle,
): boolean {
  // A manual choice is only ever about the print it was made on. When a date
  // correction re-homes the row onto a DIFFERENT print, the old preference does
  // not follow it — the desk never expressed one about this print.
  if (manual && manual.printId === next.printId) return manual.open;

  // A different print id is a new subject, not a transition.
  if (!prev || prev.printId !== next.printId) return false;

  if (OPENING_STATES.has(next.state) && next.state !== prev.state) return true;
  if (next.forcedOpenAt !== null && prev.forcedOpenAt === null) return true;
  if (next.goRequestId !== null && next.goRequestId !== prev.goRequestId) return true;
  return false;
}

export const EXPANDED_KEY_PREFIX = "vgs:print-expanded:";

/** null = the desk has expressed no preference for this print. Every access is
 *  wrapped: a private window, cleared site data or a blocked-storage browser
 *  throws on the accessor itself. */
export function readManual(printId: number, storage?: Pick<Storage, "getItem">): boolean | null {
  try {
    const s = storage ?? (typeof localStorage === "undefined" ? null : localStorage);
    if (!s) return null;
    const raw = s.getItem(`${EXPANDED_KEY_PREFIX}${printId}`);
    if (raw === "1") return true;
    if (raw === "0") return false;
    return null;
  } catch {
    return null;
  }
}

export function writeManual(printId: number, open: boolean, storage?: Pick<Storage, "setItem">): void {
  try {
    const s = storage ?? (typeof localStorage === "undefined" ? null : localStorage);
    s?.setItem(`${EXPANDED_KEY_PREFIX}${printId}`, open ? "1" : "0");
  } catch {
    /* a per-viewer convenience, never load-bearing — a blocked store is fine */
  }
}
```

`app/dashboard/today/hub-live/types.ts` — the wire shapes, copied from `PrintWatchPanel.tsx:51-122` (which is deleted in Task 10) and widened with `documentRoads` (the status route has sent it since slice B and nothing consumed it) and `outputs` (contract §2). `FirstPassReadDto`, `ActiveReadDto` and `LastAttemptDto` are imported from `../FirstPassRead` (a client module) and `CalloutView` from `@/lib/print-watch/first-pass-types` (allowlisted). `CockpitRowWire` mirrors `CockpitRow` field-for-field. Do NOT import `@/lib/queries/earnings-cockpit` or `@/lib/print-watch/types` — the first is a server module and the second, while allowlisted, would tie the client type to a server enum for no gain; declare `PrintWatchStateWire` locally with a test that pins it against the server union (below).

Add to `tests/dashboard/hub-live-expansion.test.ts`:

```ts
import type { PrintWatchState } from "@/lib/print-watch/types";
import type { PrintWatchStateWire } from "@/app/dashboard/today/hub-live/types";

describe("the wire state union tracks the server union", () => {
  it("is assignable both ways (a server-side addition fails to compile here)", () => {
    const toWire: PrintWatchStateWire = "window_open" as PrintWatchState;
    const toServer: PrintWatchState = "window_open" as PrintWatchStateWire;
    expect([toWire, toServer]).toEqual(["window_open", "window_open"]);
  });
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/dashboard/hub-live-poll-controller.test.ts tests/dashboard/hub-live-expansion.test.ts` and `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E 'hub-live' ; echo "tsc filtered done"`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cat > /tmp/msg-f6.txt <<'MSG'
feat(today): pure Hub-live mechanics — generation-ordered polling and transition-based expansion

createPollController: one generation counter and one AbortController per stream,
recursive setTimeout, pause/resume around tab visibility. deriveExpansion: opens
only on ENTERING window_open/acquired, a newly forced window or a new go request;
a first load never auto-opens, a manual toggle overrides and is remembered per
print. Both React-free so they can be tested with fake timers and no jsdom.
MSG
git commit app/dashboard/today/hub-live tests/dashboard/hub-live-poll-controller.test.ts tests/dashboard/hub-live-expansion.test.ts tests/repo/hub-live-client-boundary.test.ts -F /tmp/msg-f6.txt
```

---
### Task 7: `send-state-chips` + the Hub row's stage chips (M-F4, contract §1)

**Files:**
- Create: `app/dashboard/today/hub-live/send-state-chips.tsx`
- Modify: `app/dashboard/today/EarningsRowChips.tsx` — add the stage-chip strip, the countdown and the intel line, fed from the live cockpit row; keep every existing action untouched
- Test: `tests/dashboard/send-state-chips.test.ts`

**Interfaces:**
- Consumes: `Chip` / `ChipTone` (`app/dashboard/components/Chip.tsx`); `EmailSendState`, `PreviewStage`, `RecapStage`, `ActualStageState` from `@/lib/earnings/cockpit-stages` **as a type-only import** (M-F18); `CockpitRowWire` (Task 6).
- Produces:

```ts
export const SEND_TONES: Record<string, ChipTone>;
export const SEND_GLYPHS: Record<string, string>;
export const DELIVERY_UNKNOWN_TITLE: string;
export function chipFor(label: string, state: string): { tone: ChipTone; text: string; title?: string };
export function fmtCountdown(msLeft: number): string;
/** Every stage chip for one Hub row, in cockpit order. Pure — the component
 *  below just renders what this returns. */
export function stageChips(row: CockpitRowWire): Array<{ key: string; tone: ChipTone; text: string; title?: string; clickable: "preview" | "recap" | "actuals" | null }>;
export function StageChipStrip(props: { row: CockpitRowWire; onOpen: (what: "preview" | "recap" | "actuals") => void }): JSX.Element;
/** The row's intel + exposure line. Split by PROVENANCE, not by look: see the
 *  amendments below. */
export function RowIntelLine(props: { row: CockpitRowWire }): JSX.Element | null;
```

#### Amendments (Codex round 1) — Task 7

Findings folded here: **15** (second half — which chip figures are public and which are the desk's own), plus **one BINDING change from the cross-slice contract §1 (R-E14)** that landed after the Codex round and reverses a rule this task had written down.

**(a) Contract R-E14 — a `delivery-unknown` chip IS clickable.** The contract now records that a `delivery_unknown` row HAS a stored body: a fresh send that ended unknown stores the body it attempted, and a manual refire that ended unknown keeps the previously delivered body, with `provider_message_id` naming the last attempt. `getEmailAudit` returns such rows, and E's `GET /api/earnings/email-content` gains an additive `deliveryState` so the viewer can show a banner. So the plan's `VIEWABLE = new Set(["sent"])` and its test `"a delivery-unknown preview is NOT clickable — there is no stored email to open"` are now WRONG: there is a stored email to open, and refusing to open it is exactly what would leave the desk unable to check what went out. Replace both:

```tsx
/** Which stage states have a LOCAL body the viewer can show. A cloud send does
 *  not (the Worker composed and sent it; the Mac holds no copy), so its chip
 *  stays text — a button that opens an empty modal is a lie. A
 *  `delivery-unknown` row DOES hold a body (contract §1, R-E14: a fresh send
 *  stores what it attempted, a refire keeps what was delivered), which is
 *  precisely the row the desk most needs to read before deciding whether to
 *  resend by hand. */
const VIEWABLE = new Set(["sent", "delivery-unknown"]);
```

and in `stageChips`' test block:

```ts
  it("a delivery-unknown preview IS clickable — the attempted body is stored (contract §1, R-E14)", () => {
    const chips = stageChips(row({ stages: { ...row().stages, preview: "delivery-unknown" } }));
    expect(chips.find((c) => c.key === "preview")!.clickable).toBe("preview");
    expect(chips.find((c) => c.key === "preview")!.title).toBe(DELIVERY_UNKNOWN_TITLE);
  });
  it("a sent-by-cloud chip is still NOT clickable — the Mac holds no copy of a Worker send", () => {
    const chips = stageChips(row({ stages: { ...row().stages, recap: "sent-by-cloud" } }));
    expect(chips.find((c) => c.key === "recap")!.clickable).toBeNull();
  });
```

The `StageChipStrip` render case keeps its assertions; add that a clickable `delivery-unknown` chip renders as a `<button>` carrying the contract's title, so the warn tone is never the only signal.

**(b) Codex 15 — which numbers on a Hub row are public and which are the desk's.** The privacy rule is about PROVENANCE, not about looking financial, and a cockpit row mixes both. State it once, here, and assert it:

| Field on `CockpitRowWire` | Provenance | Renders as |
|---|---|---|
| `intel.impliedMovePct` when `intel.impliedMethod` is `"straddle"` or `"iv_approx"` | the options market | plain `formatPercent` |
| `intel.impliedMovePct` when `intel.impliedMethod === "sheet"` | the desk's OWN bogey sheet (`intel.sheetSourceLabel` names it) | `<PrivateText>` |
| `intel.histAvgAbsMovePct`, `histBeatCount`, `histQuarterCount` | the company's own reporting record | plain |
| `consensus` (and `actual`) | built from `earnings_bogeys` / the release | `<PrivateText>` for `consensus`; `actual` is the printed figure, plain |
| `netExposure` | the portfolio | `<Money>` |
| every stage chip's label and countdown | operational state, no figures | plain |

`RowIntelLine` is therefore a separate top-level component (never nested — the remount rule) rendering, in order: the implied move with its method word, the historical average and beat record, and — when non-zero — the net exposure. It is the only place in this task that renders a number, which is what makes the assertion below tractable.

```tsx
export function RowIntelLine({ row }: { row: CockpitRowWire }) {
  const intel = row.intel;
  if (!intel) return null;
  // "sheet" means the implied move came from the desk's own uploaded bogey
  // sheet — a curated number, not a market quote — so it masks with the rest
  // of the desk's figures. A straddle or IV approximation is the options
  // market talking about a listed company: public, and useless when masked.
  const impliedIsDeskOwn = intel.impliedMethod === "sheet";
  const implied =
    intel.impliedMovePct === null ? null : `±${formatPercent(intel.impliedMovePct, 1)} implied`;
  return (
    <span className="flex flex-wrap items-center gap-2 text-[11px] font-mono text-ink-faint">
      {implied !== null &&
        (impliedIsDeskOwn ? <PrivateText>{implied}</PrivateText> : <span>{implied}</span>)}
      {intel.histQuarterCount > 0 && (
        <span>
          {intel.histAvgAbsMovePct === null ? "" : `avg ±${formatPercent(intel.histAvgAbsMovePct, 1)} · `}
          beat {intel.histBeatCount}/{intel.histQuarterCount}
        </span>
      )}
      {row.netExposure !== 0 && (
        <span>
          net <Money value={row.netExposure} />
        </span>
      )}
    </span>
  );
}
```

Tests to ADD to `tests/dashboard/send-state-chips.test.ts`:

```ts
describe("privacy: public market data stays visible, the desk's own figures mask (Codex 15)", () => {
  const withIntel = (over: Partial<NonNullable<CockpitRowWire["intel"]>>) =>
    row({ intel: { impliedMovePct: 6, impliedMethod: "straddle", sheetSourceLabel: null,
                   histAvgAbsMovePct: 4.2, histBeatCount: 6, histQuarterCount: 8, ...over } });
  const render = (el: React.ReactElement) => renderToStaticMarkup(createElement(PrivacyProvider, null, el));
  const src = readFileSync("app/dashboard/today/hub-live/send-state-chips.tsx", "utf8");

  // `PrivacyProvider` holds `isPrivate` in state and only reads localStorage in
  // an effect, so under react-dom/server privacy is always OFF (the same note
  // tests/dashboard/first-pass-read.test.ts records as R-D12). The RENDER tests
  // below therefore prove the figures appear at all; WHICH wrapper each one
  // sits in is pinned by source, which is the only honest split available
  // without jsdom.
  it("renders every figure in the clear when privacy is off", () => {
    const html = render(createElement(RowIntelLine, { row: { ...withIntel({}), netExposure: 125_000 } }));
    expect(html).toContain("6.0% implied");
    expect(html).toContain("beat 6/8");
    expect(html).toContain("125,000");
  });

  it("renders nothing at all for a row with no intel, rather than an empty shell", () => {
    expect(render(createElement(RowIntelLine, { row: row({ intel: null }) }))).toBe("");
  });

  it("omits the exposure clause entirely at zero net exposure", () => {
    expect(render(createElement(RowIntelLine, { row: { ...withIntel({}), netExposure: 0 } }))).not.toContain("net");
  });

  it("puts the SHEET implied move behind PrivateText and leaves a market implied move plain", () => {
    // `impliedMethod: "sheet"` means the number came off the desk's own uploaded
    // bogey sheet — curated, not quoted — so it masks; a straddle or IV
    // approximation is the options market talking about a listed company.
    expect(src).toMatch(/impliedMethod === "sheet"/);
    expect(src).toMatch(/impliedIsDeskOwn \? <PrivateText>\{implied\}<\/PrivateText> : <span>\{implied\}<\/span>/);
  });

  it("renders net exposure through <Money> and never raw", () => {
    expect(src).toMatch(/<Money value=\{row\.netExposure\}/);
    expect(src).not.toMatch(/\{row\.netExposure\}(?!\s*!?==)/);
  });

  it("leaves the company's own reporting record public", () => {
    expect(src).toMatch(/beat \{intel\.histBeatCount\}\/\{intel\.histQuarterCount\}/);
    expect(src).not.toMatch(/<PrivateText>[^<]*histBeatCount/);
  });
});
```

(`readFileSync`, `PrivacyProvider`, `Money`, `PrivateText` and `formatPercent` join the imports; `render` mirrors `tests/dashboard/live-print-row.test.ts`'s helper of the same name.)

Step 3's `EarningsRowChips.tsx` paragraph gains: render `<RowIntelLine row={cockpitRow} />` beside `<StageChipStrip …>`, as a sibling — **not** defined inside `EarningsRowChips` (the remount trap), and not inlined into `StageChipStrip` (the chips are operational state; the intel line is figures, and mixing them would put the privacy decision in two places).

- [ ] **Step 1: Write the failing test**

`tests/dashboard/send-state-chips.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SEND_TONES, SEND_GLYPHS, DELIVERY_UNKNOWN_TITLE, chipFor, fmtCountdown, stageChips, StageChipStrip,
} from "@/app/dashboard/today/hub-live/send-state-chips";
import type { CockpitRowWire } from "@/app/dashboard/today/hub-live/types";

/** Every value E's contract §1 can put in a stage field, plus the ones that
 *  ship today. A member missing from the maps is exactly the bug this pins. */
const ALL_STAGE_STATES = [
  "sent", "sent-by-cloud", "in-flight", "delivery-unknown",
  "skipped", "pending", "missed", "waiting", "blocked", "captured", "implausible",
] as const;

const row = (o: Partial<CockpitRowWire> = {}): CockpitRowWire => ({
  eventId: 1, symbol: "XMPL1", securityId: null, title: "XMPL1 Q3", eventDate: "2026-09-10",
  eventTime: "AMC", releaseTime: "16:05", symbolStatus: "armed", consensus: "EPS 0.46", actual: null,
  stages: {
    preview: "sent",
    released: { state: "upcoming", releaseInstant: "2026-09-10T20:05:00.000Z" },
    actual: "pending",
    reaction: { state: "pending", source: null, readyAt: null },
    recap: "waiting",
  },
  netExposure: 0, isTopExposure: false, hasCallNote: false, carryover: false, intel: null,
  ...o,
});

describe("the tone and glyph maps are TOTAL over the stage unions (contract §1)", () => {
  it("every state has a tone AND a glyph — so slice E's delivery-unknown can never render as a raw word", () => {
    const missingTone = ALL_STAGE_STATES.filter((s) => SEND_TONES[s] === undefined);
    const missingGlyph = ALL_STAGE_STATES.filter((s) => SEND_GLYPHS[s] === undefined);
    expect({ missingTone, missingGlyph }).toEqual({ missingTone: [], missingGlyph: [] });
  });
  it("renders delivery-unknown exactly as the contract specifies", () => {
    expect(chipFor("rec", "delivery-unknown")).toEqual({
      tone: "warn", text: "rec ?", title: DELIVERY_UNKNOWN_TITLE,
    });
    expect(DELIVERY_UNKNOWN_TITLE).toBe(
      "The provider's response was never received — check the mailbox or the Resend log for the message id, then resend by hand if needed.",
    );
  });
  it("uses the full word in the chip's own label where there is room", () => {
    expect(stageChips(row({ stages: { ...row().stages, recap: "delivery-unknown" } })).map((c) => c.text))
      .toContain("rec ? delivery unknown");
  });
});

describe("chipFor", () => {
  it("appends the glyph when there is one and leaves a bare label when there is not", () => {
    expect(chipFor("pre", "sent")).toMatchObject({ tone: "up", text: "pre ✓" });
    expect(chipFor("pre", "pending")).toMatchObject({ tone: "neutral", text: "pre" });
  });
  it("falls back to neutral with the state word for a state nobody has mapped yet", () => {
    expect(chipFor("pre", "brand-new")).toMatchObject({ tone: "neutral", text: "pre brand-new" });
  });
});

describe("fmtCountdown", () => {
  it("counts hours, minutes-and-seconds, seconds, and says now at or past zero", () => {
    expect(fmtCountdown(3 * 3_600_000 + 4 * 60_000)).toBe("3h 4m");
    expect(fmtCountdown(4 * 60_000 + 5_000)).toBe("4m 5s");
    expect(fmtCountdown(9_000)).toBe("9s");
    expect(fmtCountdown(0)).toBe("now");
    expect(fmtCountdown(-1)).toBe("now");
  });
});

describe("stageChips", () => {
  it("renders released/preview/actual/reaction/recap in cockpit order and marks what is clickable", () => {
    const chips = stageChips(row({ stages: { ...row().stages, preview: "sent", recap: "sent-by-cloud", actual: "blocked" } }));
    expect(chips.map((c) => c.key)).toEqual(["released", "preview", "actual", "reaction", "recap"]);
    expect(chips.find((c) => c.key === "preview")!.clickable).toBe("preview");
    expect(chips.find((c) => c.key === "recap")!.clickable).toBe("recap");
    expect(chips.find((c) => c.key === "actual")!.clickable).toBe("actuals");
    expect(chips.find((c) => c.key === "reaction")!.clickable).toBeNull();
  });
  it("a delivery-unknown preview is NOT clickable — there is no stored email to open", () => {
    const chips = stageChips(row({ stages: { ...row().stages, preview: "delivery-unknown" } }));
    expect(chips.find((c) => c.key === "preview")!.clickable).toBeNull();
  });
});

describe("StageChipStrip render", () => {
  it("renders a button only for clickable chips and text for the rest, with the title on delivery-unknown", () => {
    const html = renderToStaticMarkup(
      createElement(StageChipStrip, { row: row({ stages: { ...row().stages, recap: "delivery-unknown" } }), onOpen: () => undefined }),
    );
    expect(html).toContain("delivery unknown");
    expect(html).toContain(DELIVERY_UNKNOWN_TITLE.slice(0, 40));
    expect(html).not.toMatch(/<div[^>]*onclick/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/dashboard/send-state-chips.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`app/dashboard/today/hub-live/send-state-chips.tsx` — moved verbatim from `EarningsCockpit.tsx:55-92` and extended:

```tsx
"use client";

/**
 * The cockpit's stage chips, moved into the Hub row (spec §4.6: "The Earnings
 * Cockpit folds into the Earnings Hub rows as chips. The email tri-state
 * helpers move with the chips").
 *
 * The three stage unions come from @/lib/earnings/cockpit-stages as a TYPE-ONLY
 * import: that module value-imports @/lib/calendar/reaction-snapshot and
 * @/lib/calendar/enrichment-runner, which pull @stoqey/ib — a value import from
 * here would not fail a test, it would fail `next build` (R-D20).
 */
import { Chip, type ChipTone } from "@/app/dashboard/components/Chip";
import type { CockpitRowWire } from "./types";
import type {
  ActualStageState, EmailSendState, PreviewStage, RecapStage,
} from "@/lib/earnings/cockpit-stages";

/** Compile-time proof the maps below cover every union member. A member added
 *  server-side (slice E's "delivery-unknown") fails to compile here until it
 *  gets a tone and a glyph. */
type AnyStage = NonNullable<EmailSendState> | PreviewStage | RecapStage | ActualStageState;

export const SEND_TONES: Record<AnyStage, ChipTone> & Record<string, ChipTone> = {
  sent: "up",
  "sent-by-cloud": "info",
  "in-flight": "warn",
  "delivery-unknown": "warn",
  skipped: "neutral",
  pending: "neutral",
  waiting: "neutral",
  missed: "down",
  blocked: "down",
  captured: "up",
  implausible: "warn",
};

export const SEND_GLYPHS: Record<AnyStage, string> & Record<string, string> = {
  sent: "✓",
  "sent-by-cloud": "☁",
  "in-flight": "…",
  "delivery-unknown": "?",
  skipped: "–",
  pending: "",
  waiting: "",
  missed: "✗",
  blocked: "✗",
  captured: "✓",
  implausible: "⚠",
};

/** Contract §1, verbatim. */
export const DELIVERY_UNKNOWN_TITLE =
  "The provider's response was never received — check the mailbox or the Resend log for the message id, then resend by hand if needed.";

/** Full-word labels for the states a glyph alone would under-explain. */
const FULL_WORDS: Record<string, string> = { "delivery-unknown": "delivery unknown" };

export function chipFor(label: string, state: string): { tone: ChipTone; text: string; title?: string } {
  const glyph = SEND_GLYPHS[state];
  const word = FULL_WORDS[state];
  const known = glyph !== undefined;
  const suffix = known ? [glyph, word].filter(Boolean).join(" ") : state;
  return {
    tone: SEND_TONES[state] ?? "neutral",
    text: suffix ? `${label} ${suffix}` : label,
    ...(state === "delivery-unknown" ? { title: DELIVERY_UNKNOWN_TITLE } : {}),
  };
}

export function fmtCountdown(msLeft: number): string {
  if (msLeft <= 0) return "now";
  const totalMin = Math.floor(msLeft / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const s = Math.floor((msLeft % 60_000) / 1000);
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/** Only a locally-stored, actually-delivered email can be opened in the viewer.
 *  A cloud send and a delivery-unknown row have no local body to show, so their
 *  chips are text — a button that opens an empty modal is a lie. */
const VIEWABLE = new Set(["sent"]);

export function stageChips(
  row: CockpitRowWire,
): Array<{ key: string; tone: ChipTone; text: string; title?: string; clickable: "preview" | "recap" | "actuals" | null }> {
  const released = row.stages.released;
  const releasedChip =
    released.state === "released"
      ? { tone: "gold" as ChipTone, text: "released" }
      : released.state === "upcoming"
        ? { tone: "neutral" as ChipTone, text: row.releaseTime ?? row.eventTime ?? "—" }
        : { tone: "neutral" as ChipTone, text: row.eventTime ?? "time?" };
  const reaction =
    row.stages.reaction.state === "captured"
      ? { tone: "up" as ChipTone, text: `rxn ✓${row.stages.reaction.source ? ` ${row.stages.reaction.source}` : ""}` }
      : { tone: "neutral" as ChipTone, text: "rxn" };

  return [
    { key: "released", ...releasedChip, clickable: null },
    { key: "preview", ...chipFor("pre", row.stages.preview), clickable: VIEWABLE.has(row.stages.preview) ? "preview" : null },
    { key: "actual", ...chipFor("act", row.stages.actual), clickable: row.stages.actual === "blocked" ? "actuals" : null },
    { key: "reaction", ...reaction, clickable: null },
    { key: "recap", ...chipFor("rec", row.stages.recap), clickable: VIEWABLE.has(row.stages.recap) ? "recap" : null },
  ];
}

export function StageChipStrip({
  row,
  onOpen,
}: {
  row: CockpitRowWire;
  onOpen: (what: "preview" | "recap" | "actuals") => void;
}) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      {stageChips(row).map((c) =>
        c.clickable ? (
          <button
            key={c.key}
            type="button"
            title={c.title}
            onClick={() => onOpen(c.clickable!)}
            className="relative active:scale-[0.96] transition-transform after:absolute after:content-[''] after:-inset-y-2 after:-inset-x-0.5"
          >
            <Chip tone={c.tone} size="xs" className="cursor-pointer">{c.text}</Chip>
          </button>
        ) : (
          <Chip key={c.key} tone={c.tone} size="xs" title={c.title}>{c.text}</Chip>
        ),
      )}
    </span>
  );
}
```

Then in `EarningsRowChips.tsx`: add an OPTIONAL `cockpitRow?: CockpitRowWire | null` prop and, when it is present, render `<StageChipStrip row={cockpitRow} onOpen={…} />` plus the intel line and the countdown ahead of the existing controls. `onOpen("preview" | "recap")` sets the component's existing `openPhase`; `onOpen("actuals")` opens the existing `BogeysEditModal` path. The seven existing props and every existing action stay exactly as they are, so the component still renders correctly when the controller has no row for the event (a Hub row outside the cockpit's coverage set). **Do not define `StageChipStrip` inside `EarningsRowChips`** — the remount-trap rule.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/dashboard/` and `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E 'send-state-chips|EarningsRowChips' ; echo "tsc filtered done"`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cat > /tmp/msg-f7.txt <<'MSG'
feat(today): the cockpit's stage chips move into the Hub row

chipFor / SEND_TONES / SEND_GLYPHS / fmtCountdown leave EarningsCockpit for
hub-live/send-state-chips, typed against the stage unions so slice E's
delivery-unknown cannot fall through to a raw state word; the maps are pinned
total by a test and the union import is type-only (the module behind it pulls
@stoqey/ib and would break next build as a value import).
MSG
git commit app/dashboard/today/hub-live/send-state-chips.tsx app/dashboard/today/EarningsRowChips.tsx tests/dashboard/send-state-chips.test.ts -F /tmp/msg-f7.txt
```

---
### Task 8: `live-print/*` — the panel's body becomes the expansion (M-F6, M-F16, M-F17, M-F19, contract §2/§3/§4)

**Files:**
- Create: `app/dashboard/today/live-print/helpers.ts`, `app/dashboard/today/live-print/LineRow.tsx`, `app/dashboard/today/live-print/GoControls.tsx`, `app/dashboard/today/live-print/IrPageField.tsx`, `app/dashboard/today/live-print/PrepareStatus.tsx`, `app/dashboard/today/live-print/PrintOutputs.tsx`, `app/dashboard/today/LivePrintRow.tsx`
- Modify: `tests/dashboard/print-watch-panel.test.ts` — re-point the symbol import block (`:3-19`) and the four source scans (`:805`, `:829`, `:864`, `:901`)
- Modify: `tests/dashboard/first-pass-read.test.ts:138-145` — the mount scan reads `LivePrintRow.tsx` instead of `PrintWatchPanel.tsx`
- Test: `tests/dashboard/live-print-row.test.ts`
- READ but do NOT edit: `app/dashboard/today/PrintWatchPanel.tsx` (1 486 lines — Task 10 deletes it)

**Split by the panel's own boundaries.** `PrintWatchPanel.tsx` is `PrintWatchPanel` (`:682-869` — the polling shell, which Task 9 replaces), `PrintCard` (`:873-1311` — the body, which becomes `LivePrintRow`) and `LineRow` (`:1315-1486`), over a helper block at `:131-680`. The move is COPY-then-delete: this task copies, Task 10 deletes the panel in the same commit that removes its page import. The transient duplication of `PRE_GATE_DISCLOSURE` etc. in two modules is expected and ends in Task 10.

**Interfaces:**
- Consumes: `apiFetch` (default export, `lib/http/apiFetch.ts`), `Chip`/`ChipTone`, `ScrollFade`, `PrivateText`, `formatLargeUSD`/`formatPercent` (`lib/format.ts`), `reconcile` (`@/lib/print-watch/reconcile` — allowlisted), types from `@/lib/print-watch/types` (allowlisted), `FirstPassRead` + its three DTOs (`../FirstPassRead`), `PrintStatusEntry`/`PrepareStepWire`/`PrintOutputsWire` (Task 6).
- Produces:

```ts
// app/dashboard/today/live-print/helpers.ts  — moved VERBATIM from PrintWatchPanel.tsx
export const PRE_GATE_DISCLOSURE: string;                    // :131
export const SUPERSEDED_CONFIRM_COPY: string;                // :141
export const SUPERSEDED_ACCEPT_CONFIRM_COPY: string;         // :151
export const SUPERSEDED_CANDIDATE_CONFIRM_COPY: string;      // :160
export const HOT_STATES: ReadonlySet<PrintWatchState>;
export const HOT_POLL_MS: 2_000; export const COOL_POLL_MS: 30_000; export const ENSURE_INTERVAL_MS: 60_000;
export function ladderText(sources: Record<string, string>): string;                       // :195
export function goStatusText(go: GoRequestWire | null): string | null;                     // :208
export function windowText(w: { start: string; end: string } | null, nowMs: number): string; // :228
export function deltaPct(expected: number | null, actual: number | null): DeltaResult | null; // :244
export function printStateLabel(state: PrintWatchState): { text: string; tone: ChipTone };  // :265
export function printCountLabel(prints: ReadonlyArray<{ state: PrintWatchState }>): string; // :285
export function candidateSourceLabel(c: TaggedCandidate, documents: Record<number, string> | undefined): string; // :298
export function dropOutcomeMessage(outcome: DropOutcome | undefined, rejectReason: string | null | undefined): { text: string; tone: "note" | "error" }; // :318
export function firstDroppedFile(dt: DataTransfer | null | undefined): File | null;         // :359
export function promoteSummary(lines: PrintWatchLine[]): PromoteSummary | null;             // :390
export function needsReverify(line: PrintWatchLine): boolean;                               // :460
export function canAcceptLine(line: PrintWatchLine): boolean;                               // :537
export function acceptableRivals(line: PrintWatchLine): TaggedCandidate[];                  // :569
export function presentState(line: PrintWatchLine): { text: string; icon: string; tone: ChipTone }; // :601 + the NEW retired case
export function formatContractValue(contract: LineContract, value: number | null): string;  // :624
export function formatContractRange(contract: LineContract, value: number | null, valueHigh: number | null): string; // :643
export function basisNote(contract: LineContract): string | null;                           // :654
export function fileToBase64(file: File): Promise<string>;                                  // :662
export function etClock(iso: string): string;                                               // :223

// components
export default function LineRow(props: { line: PrintWatchLine; documents: Record<number, string> | undefined; onUnaccept: () => void; unaccepting: boolean; onAccept: () => void; accepting: boolean; onAcceptCandidate: (docId: number, representation: string) => void; acceptingCandidateKey: string | null; noEventId: boolean }): JSX.Element;
export default function GoControls(props: { eventId?: number; goRequest: GoRequestWire | null; hasWindow: boolean; onChanged: () => Promise<void>; onNote: (text: string) => void; onError: (text: string) => void }): JSX.Element;
export default function IrPageField(props: { symbol: string; onNote: (text: string) => void; onError: (text: string) => void }): JSX.Element;
export default function PrepareStatus(props: { steps: PrepareStepWire[] | undefined }): JSX.Element | null;
export default function PrintOutputs(props: { printId: number; outputs: PrintOutputsWire | undefined; onChanged: () => Promise<void> }): JSX.Element | null;
export default function LivePrintRow(props: { print: PrintStatusEntry; prepareSteps: PrepareStepWire[] | undefined; onChanged: () => Promise<void> }): JSX.Element;
```

#### Amendments (Codex round 1) — Task 8

Findings folded here: **11** (the IR-page field can erase a working configuration), **17(b)** = **F-S8** (`PrintOutputs`' Interfaces block omits `promote`), plus one BINDING addition from the cross-slice contract §3 that landed after the Codex round. This block REPLACES the `IrPageField` and `PrintOutputs` lines in the Interfaces block, ADDS a route file and a test file to the task, REPLACES Step 3(d)'s `IrPageField`, and ADDS to Step 3(f) and to Step 1(c)'s tests.

**Files (amended):**
- Modify: **`app/api/print-watch/sources/route.ts`** — ADD a read-only `GET`; slice B's `PUT` is untouched (ownership extended, contract §6; E never touches this file)
- Test: **`tests/api/print-watch-sources-get.test.ts`**

**Interfaces (replacing two lines):**

```ts
export default function IrPageField(props: { symbol: string; onNote: (text: string) => void; onError: (text: string) => void }): JSX.Element;
export default function PrintOutputs(props: {
  printId: number;
  outputs: PrintOutputsWire | undefined;
  onChanged: () => Promise<void>;
  /** The promote control, owned by LivePrintRow so the three 409 confirms stay
   *  in ONE place (F-S8: the implementation always had this; the Interfaces
   *  block did not say so). */
  promote: { label: string; disabled: boolean; title: string; busy: boolean; onClick: () => void };
}): JSX.Element | null;
```

**(a) Codex 11 — a PUT-only control can erase a working configuration.** Open an armed row, glance at an empty box, press Save, and slice B's "empty clears the row" rule deletes an IR page the desk configured weeks ago — with a cheerful "Cleared" as the only trace. The fix is a read path, and the honest place for it is B's own route.

ADD to `app/api/print-watch/sources/route.ts` (above `PUT`; `SYMBOL_RE` and the imports are shared, `getPrintWatchSource` joins the store import):

```ts
/**
 * GET /api/print-watch/sources?symbol=XMPL1 — what is stored for one symbol.
 *
 * A PURE read (`getPrintWatchSource` is a single SELECT), so the
 * no-state-changing-GET guard stays satisfied. It exists because the PUT above
 * treats an empty `irPageUrl` as CLEAR: without a read, the first UI for this
 * route (slice F's IrPageField) would open with an empty box over a configured
 * row and erase it on the first Save. Returns `null` — not a 404 — for a symbol
 * with nothing stored: "nothing configured" is an ordinary answer, not a
 * missing resource.
 */
export async function GET(request: NextRequest) {
  try {
    const raw = new URL(request.url).searchParams.get("symbol");
    if (typeof raw !== "string" || !raw.trim()) {
      return NextResponse.json({ success: false, error: "Query param 'symbol' is required." }, { status: 400 });
    }
    const symbol = raw.trim().toUpperCase();
    if (!SYMBOL_RE.test(symbol)) {
      return NextResponse.json(
        {
          success: false,
          error: "Query param 'symbol' must be a ticker (letters, digits, '.' or '-', up to 12 characters).",
        },
        { status: 400 },
      );
    }
    const row = getPrintWatchSource(db, symbol);
    return NextResponse.json({
      success: true,
      data: row
        ? { symbol: row.symbol, irPageUrl: row.ir_page_url, linkMustContain: row.link_must_contain }
        : null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
```

`tests/api/print-watch-sources-get.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

let db: Database.Database;
vi.mock("@/lib/db", () => ({ get db() { return db; } }));

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  vi.resetModules();
});

describe("GET /api/print-watch/sources", () => {
  it("returns null for a symbol with nothing stored — not a 404", async () => {
    const { GET } = await import("@/app/api/print-watch/sources/route");
    const res = await GET(new Request("http://localhost/api/print-watch/sources?symbol=XMPL1") as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: null });
  });

  it("returns what the PUT stored, uppercasing the symbol the same way", async () => {
    const { GET, PUT } = await import("@/app/api/print-watch/sources/route");
    await PUT(new Request("http://localhost/api/print-watch/sources", {
      method: "PUT",
      body: JSON.stringify({ symbol: "xmpl1", irPageUrl: "https://example.com/ir", linkMustContain: "press" }),
    }) as never);
    const body = await (await GET(new Request("http://localhost/api/print-watch/sources?symbol=xmpl1") as never)).json();
    expect(body).toEqual({
      success: true,
      data: { symbol: "XMPL1", irPageUrl: "https://example.com/ir", linkMustContain: "press" },
    });
  });

  it("refuses a missing or malformed symbol with 400 and says which", async () => {
    const { GET } = await import("@/app/api/print-watch/sources/route");
    expect((await GET(new Request("http://localhost/api/print-watch/sources") as never)).status).toBe(400);
    expect((await GET(new Request("http://localhost/api/print-watch/sources?symbol=AC%20ME") as never)).status).toBe(400);
  });
});
```

(the `no-state-changing-get` scan covers this new GET automatically — it scans every GET-exporting `route.ts`.)

**(b) Step 3(d) REPLACEMENT — `IrPageField` reads before it writes.**

```tsx
"use client";

import { useEffect, useState } from "react";
import apiFetch from "@/lib/http/apiFetch";

/**
 * The first UI for /api/print-watch/sources (M-F16). Slice B shipped the route
 * with zero callers, and its PUT treats an empty url as CLEAR — so this control
 * must never present an empty box it did not first prove is empty. It loads,
 * shows what is stored, and keeps Save disabled until it knows.
 */
export default function IrPageField({ symbol, onNote, onError }: {
  symbol: string;
  onNote: (text: string) => void;
  onError: (text: string) => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const [hasStored, setHasStored] = useState(false);
  const [value, setValue] = useState("");
  const [mustContain, setMustContain] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const ac = new AbortController();
    setLoaded(false);
    (async () => {
      try {
        const res = await apiFetch(`/api/print-watch/sources?symbol=${encodeURIComponent(symbol)}`, { signal: ac.signal });
        const data = (await res.json().catch(() => null)) as
          { success?: boolean; error?: string; data?: { irPageUrl: string; linkMustContain: string | null } | null } | null;
        if (ac.signal.aborted) return;
        if (!res.ok || !data?.success) {
          onError(data?.error ?? `Could not read the stored IR page (HTTP ${res.status}).`);
          return;                       // stays UNLOADED, so Save stays disabled
        }
        setHasStored(data.data != null);
        setValue(data.data?.irPageUrl ?? "");
        setMustContain(data.data?.linkMustContain ?? "");
        setLoaded(true);
      } catch (err) {
        if (ac.signal.aborted) return;
        onError(err instanceof Error ? err.message : "Could not reach the server for the stored IR page.");
      }
    })();
    return () => ac.abort();
  }, [symbol, onError]);

  async function put(body: Record<string, unknown>, describe: (cleared: boolean | undefined) => string) {
    setBusy(true);
    try {
      const res = await apiFetch("/api/print-watch/sources", {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => null)) as
        { success?: boolean; error?: string; data?: { symbol: string; cleared?: boolean } } | null;
      if (!res.ok || !data?.success) {
        onError(data?.error ?? `Could not save the IR page (HTTP ${res.status}).`);
        return;
      }
      onNote(describe(data.data?.cleared));
      setHasStored(data.data?.cleared === true ? false : true);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  const save = () =>
    void put(
      { symbol, irPageUrl: value.trim(), ...(mustContain.trim() ? { linkMustContain: mustContain.trim() } : {}) },
      () => `Saved — the IR lane will scan this page for ${symbol} from the next poll.`,
    );

  /** Clearing is its OWN button. An empty Save used to mean "clear", which is a
   *  destructive action hiding inside a save. */
  const clear = () =>
    void put({ symbol, irPageUrl: "" }, (cleared) =>
      cleared === false
        ? `No IR page was stored for ${symbol}, so nothing was cleared.`
        : `Cleared the stored IR page for ${symbol} — the IR lane will stop polling it.`,
    );

  return (
    <div className="flex flex-wrap items-end gap-2 text-[12px]">
      <label className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wider text-ink-faint">IR page</span>
        <input type="url" value={value} onChange={(e) => setValue(e.target.value)}
          placeholder={loaded ? "https://investors.example.com/news" : "loading…"}
          disabled={!loaded || busy}
          className="w-[22rem] max-w-full bg-raised border border-edge rounded px-2 py-1 font-mono text-[12px] text-ink focus:outline-none focus:border-gold" />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wider text-ink-faint">Link must contain</span>
        <input type="text" value={mustContain} onChange={(e) => setMustContain(e.target.value)}
          placeholder="press-release" disabled={!loaded || busy}
          className="w-[11rem] max-w-full bg-raised border border-edge rounded px-2 py-1 font-mono text-[12px] text-ink focus:outline-none focus:border-gold" />
      </label>
      <button type="button" onClick={save} disabled={!loaded || busy || value.trim() === ""}
        title={!loaded ? "Reading what is stored for this symbol…" : value.trim() === "" ? "Type a page address, or use “clear the stored page”." : "Save this IR page"}
        className="border border-edge rounded px-2 py-1 text-ink-dim hover:text-gold disabled:opacity-50">
        Save
      </button>
      <button type="button" onClick={clear} disabled={!loaded || busy || !hasStored}
        title={!hasStored ? "Nothing is stored for this symbol." : "Remove the stored IR page"}
        className="border border-edge rounded px-2 py-1 text-ink-faint hover:text-down disabled:opacity-50">
        clear the stored page
      </button>
    </div>
  );
}
```

The helper line "Leave it empty and save to clear the stored page." is DELETED — that behaviour is now a button, not a trick.

**(c) Contract §3 — `delivery_unknown` gained an optional `note`.** The contract's `SendRecapOutcome` now carries `note?: string` on the `delivery_unknown` arm ("why it is unknown: timeout, ambiguous provider failure, post-accept persistence failure, reaper"). That arm has no `reason`, so the Step 3(f) recap handler would render a bare `delivery_unknown` and throw away the only sentence that tells the desk what to do. Replacement for the five-line recap result block:

```tsx
      const data = (await res.json().catch(() => null)) as { success?: boolean; error?: string; data?: Record<string, unknown> } | null;
      if (!res.ok || !data?.success) { setNote(data?.error ?? `Recap failed (HTTP ${res.status}).`); return; }
      // Every coordination outcome is a 200 (contract §3), so the outcome word
      // IS the answer. `reason` carries a refusal or a failure; `note` carries
      // why a delivery_unknown is unknown. Both are the server's own words and
      // are rendered verbatim — never re-phrased, never swallowed.
      const outcome = String(data.data?.outcome ?? "");
      const detail = data.data?.reason ?? data.data?.note;
      setNote(detail === undefined ? outcome : `${outcome} — ${String(detail)}`);
      await onChanged();
```

**(d) Tests.** In Step 1(c), every `createElement(PrintOutputs, …)` call gains the `promote` prop (F-S8), and three cases are added:

```ts
const promote = { label: "Promote", disabled: false, title: "Promote the headline pair", busy: false, onClick: () => undefined };
// …every existing call becomes e.g.
//   render(createElement(PrintOutputs, { printId: 1, outputs, onChanged: async () => undefined, promote }))

  it("renders the promote control it is handed rather than re-implementing the 409 confirms (F-S8)", () => {
    const html = render(createElement(PrintOutputs, { printId: 1, outputs, onChanged: async () => undefined, promote }));
    expect(html).toContain("Promote");
    expect(src).not.toMatch(/SUPERSEDED_ACCEPT_CONFIRM_COPY|promoteHeadline/);
  });
  it("renders a delivery_unknown note verbatim, because that arm carries no reason (contract §3)", () => {
    expect(src).toMatch(/data\.data\?\.reason \?\? data\.data\?\.note/);
  });
```

and, for the new field:

```ts
describe("IrPageField reads before it writes (Codex 11)", () => {
  const src = readFileSync("app/dashboard/today/live-print/IrPageField.tsx", "utf8");
  it("GETs the stored row for its symbol and keeps Save disabled until it lands", () => {
    expect(src).toMatch(/\/api\/print-watch\/sources\?symbol=/);
    expect(src).toMatch(/disabled=\{!loaded/);
  });
  it("makes clearing its own button, never an empty Save", () => {
    expect(src).toContain("clear the stored page");
    expect(src).toMatch(/irPageUrl: ""/);
    expect(src).not.toMatch(/Leave it empty and save/);
  });
  it("explains all three outcomes in domain language and swallows nothing", () => {
    expect(src).toMatch(/nothing was cleared/);
    expect(src).toMatch(/will stop polling it/);
    expect(src).toMatch(/from the next poll/);
    expect(src).not.toMatch(/catch\s*\{\s*\}/);
  });
});
```

(the original two-case `describe("IrPageField (M-F16)")` is replaced by this one.)

The commit pathspec in Step 5 gains `app/api/print-watch/sources/route.ts tests/api/print-watch-sources-get.test.ts`.

- [ ] **Step 1: Write the failing tests**

(a) Re-point `tests/dashboard/print-watch-panel.test.ts`. Change ONLY the import target and the four scanned paths — **every one of its 61 assertions must survive unchanged**:

```ts
import {
  ladderText, promoteSummary, needsReverify, canAcceptLine, acceptableRivals, deltaPct,
  printStateLabel, printCountLabel, candidateSourceLabel, dropOutcomeMessage, firstDroppedFile,
  PRE_GATE_DISCLOSURE, SUPERSEDED_CONFIRM_COPY, goStatusText, windowText,
} from "@/app/dashboard/today/live-print/helpers";
```
and in the four source-scan describes:
- `describe("per-candidate accept control (panel source)")` → `readFileSync("app/dashboard/today/live-print/LineRow.tsx", "utf8")` for the `acceptableRivals(line)` / `"accept this"` assertions, and `readFileSync("app/dashboard/today/LivePrintRow.tsx", "utf8")` for the `postAccept({ accept: [{ metric_id: metricId, doc_id: docId, representation }] })` / `setAcceptingCandidateKey(null)` / `SUPERSEDED_CANDIDATE_CONFIRM_COPY` assertions (the handler lives on the row, the markup on the line — same split the panel had between `PrintCard` and `LineRow`).
- `describe("per-line accept control (panel source)")` → `LineRow.tsx` for the button markup and the hover-only check; `LivePrintRow.tsx` for `postAccept({ accept: [metricId] })`, `postAccept({ accept: agreedIds })` and `apiFetch("/api/print-watch/accept"`.
- `describe("verify table horizontal scroll affordance (panel source)")` → `LivePrintRow.tsx`.
- `describe("PrintWatchPanel source — slice C controls")` → rename to `live-print source — slice C controls` and scan `app/dashboard/today/live-print/GoControls.tsx`; the `goStatusText(print.goRequest` assertion moves to `LivePrintRow.tsx`.

(b) `tests/dashboard/first-pass-read.test.ts` — the `describe("mount")` case at `:138` scans `LivePrintRow.tsx`:

```ts
    const src = readFileSync("app/dashboard/today/LivePrintRow.tsx", "utf8");
    expect(src.match(/<FirstPassRead\b/g)).toHaveLength(1);
    expect(src).toMatch(/<FirstPassRead[^>]*onChanged=\{onChanged\}/);
```

(c) `tests/dashboard/live-print-row.test.ts` — the new behaviour:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PrivacyProvider } from "@/lib/privacy/context";
import PrintOutputs from "@/app/dashboard/today/live-print/PrintOutputs";
import PrepareStatus from "@/app/dashboard/today/live-print/PrepareStatus";
import { presentState } from "@/app/dashboard/today/live-print/helpers";
import type { PrintOutputsWire, PrepareStepWire } from "@/app/dashboard/today/hub-live/types";
import type { PrintWatchLine } from "@/lib/print-watch/types";

const render = (el: React.ReactElement) =>
  renderToStaticMarkup(createElement(PrivacyProvider, null, el));

const contract = { metric_id: "revenue_q", label: "Revenue", definition: "d", basis: "na", period: "Q", currency: "USD", unit: "usd", kind: "point", segment: null } as const;
const line = (o: Partial<PrintWatchLine> = {}): PrintWatchLine => ({
  metric_id: "revenue_q", contract, expected: { value: 3.85e9, value_high: null, whisper: null, source_label: "Sheet A" },
  state: "agreed", value: 4.0e9, value_high: null, snippet: null, source_doc_id: 1, candidates_json: "[]", ...o,
});

describe("presentState — the retired case (M-F17)", () => {
  it("names a retired line instead of falling through to pending", () => {
    expect(presentState(line({ state: "retired" }))).toEqual({
      text: "retired — definition changed", icon: "⌀", tone: "neutral",
    });
  });
  it("still renders every other state exactly as the panel did", () => {
    expect(presentState(line({ state: "agreed" }))).toMatchObject({ text: "agreed — verify" });
    expect(presentState(line({ state: "pending", value: null }))).toMatchObject({ text: "pending" });
  });
});

describe("the Δ column is masked whenever the bogey is (M-F19)", () => {
  const src = readFileSync("app/dashboard/today/live-print/LineRow.tsx", "utf8");
  it("wraps the delta cell in PrivateText on the same condition as the bogey cell", () => {
    // A masked bogey with an unmasked Δ leaks the bogey by division.
    expect(src).toMatch(/Δ vs bogey|delta/i);
    const deltaCell = src.slice(src.indexOf("delta === null"));
    expect(deltaCell).toMatch(/<PrivateText/);
  });
});

describe("PrintOutputs (contract §2/§3)", () => {
  const outputs: PrintOutputsWire = {
    printSheet: { enabled: true, reason: null },
    sendRecap: { enabled: false, reason: "Accept the headline pair first — EPS (adjusted or GAAP) and revenue must both be accepted with a reported value.", state: "unsent", providerMessageId: null },
  };
  it("renders NOTHING when the payload has no outputs (slice E unmerged)", () => {
    expect(render(createElement(PrintOutputs, { printId: 1, outputs: undefined, onChanged: async () => undefined }))).toBe("");
  });
  it("renders all three buttons when outputs is present", () => {
    const html = render(createElement(PrintOutputs, { printId: 1, outputs, onChanged: async () => undefined }));
    expect(html).toContain("Print sheet");
    expect(html).toContain("Promote");
    expect(html).toContain("Send recap now");
  });
  it("shows a disabled reason as BOTH the title and visible text, never as colour alone", () => {
    const html = render(createElement(PrintOutputs, { printId: 1, outputs, onChanged: async () => undefined }));
    expect(html).toContain(`title="${outputs.sendRecap.reason!.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;")}"`);
    expect(html).toContain("Accept the headline pair first");
    expect(html).toMatch(/disabled=""/);
  });
  it("renders the recap state word when the recap is not unsent", () => {
    const sent: PrintOutputsWire = { ...outputs, sendRecap: { enabled: false, reason: "sent", state: "sent", providerMessageId: "re_123" } };
    expect(render(createElement(PrintOutputs, { printId: 1, outputs: sent, onChanged: async () => undefined }))).toContain("sent");
  });
  const src = readFileSync("app/dashboard/today/live-print/PrintOutputs.tsx", "utf8");
  it("posts the two E routes exactly once each and renders data.outcome + data.reason verbatim", () => {
    expect(src.match(/apiFetch\("\/api\/print-watch\/print-sheet"/g)).toHaveLength(1);
    expect(src.match(/apiFetch\("\/api\/print-watch\/send-recap"/g)).toHaveLength(1);
    expect(src).toMatch(/data\.data\.outcome/);
    expect(src).toMatch(/data\.data\.reason/);
  });
  it("checks res.ok AND data.success and never swallows a failure", () => {
    expect(src).toMatch(/!res\.ok \|\| !data\?\.success/);
    expect(src).not.toMatch(/catch\s*\{\s*\}/);
  });
});

describe("PrepareStatus (M-F15)", () => {
  const step = (o: Partial<PrepareStepWire> = {}): PrepareStepWire =>
    ({ event_id: 1, step: "intel", status: "done", input_fingerprint: "f", attempts: 1, last_error: null, updated_at: "2026-09-10T20:00:00.000Z", ...o });
  it("renders nothing when the controller has not fetched the steps yet", () => {
    expect(render(createElement(PrepareStatus, { steps: undefined }))).toBe("");
  });
  it("says 'ready' when every step is done", () => {
    expect(render(createElement(PrepareStatus, { steps: [step(), step({ step: "con_id" })] }))).toContain("ready");
  });
  it("calls a pending step WAITING, never stuck or failed", () => {
    const html = render(createElement(PrepareStatus, { steps: [step({ step: "intel", status: "pending" })] }));
    expect(html).toContain("waiting");
    expect(html).not.toMatch(/stuck|failed/);
  });
  it("names the IR page as the fix when ir_baseline is the only step still waiting (TODO.md slice-B minor)", () => {
    const html = render(createElement(PrepareStatus, { steps: [step(), step({ step: "ir_baseline", status: "pending" })] }));
    expect(html).toContain("waiting on an IR page");
  });
  it("surfaces a real failure with its message", () => {
    const html = render(createElement(PrepareStatus, { steps: [step({ step: "intel", status: "failed", last_error: "TWS offline" })] }));
    expect(html).toContain("intel failed — TWS offline");
  });
});

describe("GoControls — the paste box (contract §4)", () => {
  const src = readFileSync("app/dashboard/today/live-print/GoControls.tsx", "utf8");
  it("posts a pasted URL and a pasted file to the SAME go route, with the route's own body shape", () => {
    expect(src).toMatch(/JSON\.stringify\(\{ eventId, url \}\)/);
    expect(src).toMatch(/JSON\.stringify\(\{ eventId, contentBase64, filename/);
    expect(src.match(/apiFetch\("\/api\/print-watch\/go"/g)!.length).toBeGreaterThanOrEqual(1);
  });
  it("uses a native file input so the phone can pick a file (M-F10)", () => {
    expect(src).toMatch(/type="file"/);
  });
  it("renders the server's refusal verbatim rather than a generic failure", () => {
    expect(src).toMatch(/data\?\.error/);
    expect(src).not.toMatch(/catch\s*\{\s*\}/);
  });
});

describe("IrPageField (M-F16)", () => {
  const src = readFileSync("app/dashboard/today/live-print/IrPageField.tsx", "utf8");
  it("PUTs the sources route with the symbol and the url", () => {
    expect(src).toMatch(/apiFetch\("\/api\/print-watch\/sources", \{\s*method: "PUT"/);
    expect(src).toMatch(/irPageUrl/);
  });
  it("explains the empty-string CLEAR in domain language rather than hiding it", () => {
    expect(src).toMatch(/clear/i);
    expect(src).toMatch(/data\.data\.cleared/);
  });
});

describe("LivePrintRow — no hover-only affordances, no div onClick, keyboard-first", () => {
  const src = readFileSync("app/dashboard/today/LivePrintRow.tsx", "utf8");
  it("has no opacity-0 reveal and no clickable div (touch tap-trap + keyboard rules)", () => {
    expect(src).not.toMatch(/opacity-0/);
    expect(src).not.toMatch(/<div[^>]*onClick/);
  });
  it("keeps every table inside its own horizontal scroller so 752px of content never scrolls the page", () => {
    expect(src).toMatch(/<ScrollFade>/);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/dashboard/print-watch-panel.test.ts tests/dashboard/first-pass-read.test.ts tests/dashboard/live-print-row.test.ts`
Expected: FAIL — `@/app/dashboard/today/live-print/helpers` and the six component modules do not exist.

- [ ] **Step 3: Create the modules**

**(a) `live-print/helpers.ts`** — copy `PrintWatchPanel.tsx:131-680` verbatim (the four confirm-copy constants, the three cadence constants, `HOT_STATES`, `LADDER_ORDER`/`LADDER_LABELS`, `capitalize`, `ladderText`, `ROAD_LABELS`, `goStatusText`, `etClock`, `windowText`, `DeltaResult`/`deltaPct`, `printStateLabel`, `printCountLabel`, `candidateSourceLabel`, `DropOutcome`/`dropOutcomeMessage`, `firstDroppedFile`, `formatEpsValue`, `PromoteSummary`/`promoteSummary`, `valuesDiverge`, `needsReverify`, `candidateKey`, `canAcceptLine`, `acceptableRivals`, `ChipPresentation`/`presentState`, `formatContractValue`, `formatContractRange`, `basisNote`, `fileToBase64`), EXPORTING every symbol the panel exported plus `presentState`, `candidateKey`, `formatContractValue`, `formatContractRange`, `basisNote`, `etClock`, `fileToBase64`, `HOT_STATES`, `HOT_POLL_MS`, `COOL_POLL_MS`, `ENSURE_INTERVAL_MS`, `SUPERSEDED_ACCEPT_CONFIRM_COPY`, `SUPERSEDED_CANDIDATE_CONFIRM_COPY` (Task 9's poll cadence and Tasks 8/9's components need them). `GoRequestSummary` becomes `GoRequestWire` from `../hub-live/types`. It is NOT a `"use client"` file (it has no JSX and no hooks) but everything in it is imported by client files, so it may import only `@/lib/print-watch/{types,reconcile}` and `@/lib/format` — the same set the panel imports today.

One CHANGE inside the copy (M-F17):

```ts
export function presentState(line: PrintWatchLine): ChipPresentation {
  if (line.state === "accepted") {
    return needsReverify(line)
      ? { text: "superseded — re-verify", icon: "⟳", tone: "down" }
      : { text: "accepted", icon: "✓✓", tone: "up" };
  }
  switch (line.state) {
    case "agreed": return { text: "agreed — verify", icon: "✓", tone: "up" };
    case "single_source": return { text: "single source — verify", icon: "◐", tone: "warn" };
    case "conflict": return { text: "conflict", icon: "⚠", tone: "down" };
    case "flash": return { text: "wire flash", icon: "⚡", tone: "gold" };
    case "blank": return { text: "not disclosed", icon: "—", tone: "neutral" };
    // Slice F: recompileContracts renames a superseded definition's row to
    // <metric_id>~retired~<n> and books it 'retired'. It is history, not a
    // measurement in progress — before slice F it fell through to "pending",
    // which read as "still coming".
    case "retired": return { text: "retired — definition changed", icon: "⌀", tone: "neutral" };
    case "pending":
    default: return { text: "pending", icon: "⋯", tone: "neutral" };
  }
}
```

**(b) `live-print/LineRow.tsx`** (`"use client"`) — `PrintWatchPanel.tsx:1315-1486` verbatim, with three changes:
1. the Δ cell wraps in `<PrivateText>` whenever `line.expected` is non-null (M-F19):
```tsx
        <td className={`py-2 pr-3 align-top text-right font-mono tabular-nums ${
          delta === null ? "text-ink-faint" : delta.sign === 1 ? "text-up" : delta.sign === -1 ? "text-down" : "text-ink-dim"
        }`}>
          {/* The bogey above is the desk's own curated number and is masked;
              a visible Δ against a masked bogey gives it back by division. */}
          {line.expected ? <PrivateText>{delta ? delta.label : "—"}</PrivateText> : (delta ? delta.label : "—")}
        </td>
```
2. a retired row renders dimmed with no accept control and its caption:
```tsx
  const isRetired = line.state === "retired";
  // …on the <tr>: className={`border-t border-edge ${isFlash ? "border-dashed" : ""} ${isRetired ? "opacity-60" : ""}`}
  // …in the state cell: {isRetired ? null : line.state === "accepted" ? (…unaccept…) : canAcceptLine(line) ? (…accept…) : null}
```
   (`canAcceptLine` already returns `false` for `retired` — it whitelists `agreed`/`single_source`/`flash` — so this is belt-and-braces, and a test pins it.)
3. it imports its helpers from `./helpers` instead of the file scope.

**(c) `live-print/GoControls.tsx`** (`"use client"`) — `handleGo`/`handleExtend` moved verbatim from `PrintWatchPanel.tsx:1091-1138` plus the two buttons from `:1188-1207`, and the NEW paste box:

```tsx
  const [url, setUrl] = useState("");
  const [pasting, setPasting] = useState(false);

  /** Contract §4: `{ eventId, url }` or `{ eventId, contentBase64, filename }` —
   *  the go route's own body, unchanged. `requestGo` owns every rule about what
   *  may be pressed (https-only, SSRF-safe, no secret-bearing query key, under
   *  10 MB, readable); this box never second-guesses it and shows the refusal
   *  the server sends, verbatim. */
  async function postGo(body: Record<string, unknown>, okNote: string) {
    if (eventId === undefined) { onError("This print has no event reference from the server — cannot press go."); return; }
    setPasting(true);
    try {
      const res = await apiFetch("/api/print-watch/go", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => null)) as
        { success?: boolean; error?: string; data?: { requestId: number; wakeError?: string | null } } | null;
      if (!res.ok || !data?.success) { onError(data?.error ?? `Go failed (HTTP ${res.status}).`); return; }
      onNote(data.data?.wakeError
        ? `${okNote} Could not wake the watcher immediately (${data.data.wakeError}) — it will pick this up on its next poll.`
        : okNote);
      setUrl("");
      await onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Go failed.");
    } finally {
      setPasting(false);
    }
  }

  const submitUrl = () => void postGo({ eventId, url: url.trim() }, "Link accepted — acquiring now.");
  const submitFile = async (file: File) => {
    const contentBase64 = await fileToBase64(file);
    await postGo({ eventId, contentBase64, filename: file.name }, "File accepted — parsing now.");
  };
```
plus the markup: a text input with `placeholder="Paste the release link"` and an adjacent `Use link` button (`onKeyDown` Enter submits), and a `<label>`-wrapped native `<input type="file" accept=".html,.htm,.txt,.pdf,text/html,text/plain,application/pdf" className="hidden">` labelled `⇪ Paste file` — the exact idiom the panel already uses at `:1208-1226` so it works on iOS. Every control is disabled while `pasting` and carries a `title` explaining any disabled state.

**(d) `live-print/IrPageField.tsx`** (`"use client"`) — new (M-F16):

```tsx
  async function save() {
    setSaving(true);
    try {
      const res = await apiFetch("/api/print-watch/sources", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, irPageUrl: value.trim(), ...(mustContain.trim() ? { linkMustContain: mustContain.trim() } : {}) }),
      });
      const data = (await res.json().catch(() => null)) as
        { success?: boolean; error?: string; data?: { symbol: string; cleared?: boolean } } | null;
      if (!res.ok || !data?.success) { onError(data?.error ?? `Could not save the IR page (HTTP ${res.status}).`); return; }
      onNote(data.data?.cleared === true
        ? `Cleared the stored IR page for ${symbol} — the IR lane will stop polling it.`
        : data.data?.cleared === false
          ? `No IR page was stored for ${symbol}, so nothing was cleared.`
          : `Saved — the IR lane will scan this page for ${symbol} from the next poll.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not reach the server.");
    } finally {
      setSaving(false);
    }
  }
```
with a `<label>`ed text input, a `Save` button, and helper copy: `Leave it empty and save to clear the stored page.`

**(e) `live-print/PrepareStatus.tsx`** (`"use client"`, M-F15):

```tsx
const STEP_LABELS: Record<string, string> = {
  con_id: "contract id", consensus_row: "consensus row", intel: "intel",
  newsletter_rescan: "newsletter re-scan", ir_baseline: "IR baseline",
};

export default function PrepareStatus({ steps }: { steps: PrepareStepWire[] | undefined }) {
  if (!steps) return null;                       // not fetched yet — say nothing
  if (steps.length === 0) return null;
  const failed = steps.filter((s) => s.status === "failed");
  const waiting = steps.filter((s) => s.status === "pending" || s.status === "claimed");
  if (failed.length === 0 && waiting.length === 0) {
    return <p className="text-[11px] font-mono text-ink-faint">prep · ready</p>;
  }
  // A pending ir_baseline on a symbol with no stored IR page is the NORMAL
  // resting state, not a stall (docs/plans/TODO.md, slice-B deferred minors) —
  // so nothing here ever says "stuck", and the field below is the fix.
  const irOnly = waiting.length === 1 && waiting[0].step === "ir_baseline" && failed.length === 0;
  return (
    <p className="text-[11px] font-mono text-ink-faint">
      prep ·{" "}
      {failed.map((s) => `${STEP_LABELS[s.step] ?? s.step} failed — ${s.last_error ?? "no reason recorded"}`).join(" · ")}
      {failed.length > 0 && waiting.length > 0 ? " · " : ""}
      {irOnly
        ? "waiting on an IR page"
        : waiting.length > 0
          ? `waiting: ${waiting.map((s) => STEP_LABELS[s.step] ?? s.step).join(", ")}`
          : ""}
    </p>
  );
}
```

**(f) `live-print/PrintOutputs.tsx`** (`"use client"`, contract §2/§3) — the three buttons. `Promote` is the panel's existing promote control moved unchanged (it posts `/api/print-watch/accept` with `promoteHeadline: true` through the row's `postAccept`, so `LivePrintRow` passes it in as a prop rather than re-implementing the 409 handling):

```tsx
export default function PrintOutputs({ printId, outputs, onChanged, promote }: {
  printId: number;
  outputs: PrintOutputsWire | undefined;
  onChanged: () => Promise<void>;
  promote: { label: string; disabled: boolean; title: string; busy: boolean; onClick: () => void };
}) {
  // Slice E owns these routes. Until it merges, the status payload has no
  // `outputs` and this whole row is absent — no buttons, no error, no claim.
  if (!outputs) return null;
  …
}
```
`Print sheet`: disabled when `!outputs.printSheet.enabled`, with `outputs.printSheet.reason` as BOTH the `title` and a visible `<p className="text-[11px] text-ink-faint">` under the button. On click it POSTs `{ printId }` and renders `Sent to the printer — <road>, <pages> page(s)` from `data.data`; a 409 renders the server's `error` verbatim. `Send recap now`: disabled when `!outputs.sendRecap.enabled`, reason shown the same way, and the button's own line always names `outputs.sendRecap.state` plus `providerMessageId` when there is one; on click it POSTs `{ printId }`, and because **every coordination outcome is a 200**, it renders `data.data.outcome` and `data.data.reason` verbatim rather than treating anything but a transport failure as an error:

```tsx
      const data = (await res.json().catch(() => null)) as { success?: boolean; error?: string; data?: Record<string, unknown> } | null;
      if (!res.ok || !data?.success) { setNote(data?.error ?? `Recap failed (HTTP ${res.status}).`); return; }
      const outcome = String(data.data?.outcome ?? "");
      const reason = data.data?.reason === undefined ? "" : ` — ${String(data.data.reason)}`;
      setNote(`${outcome}${reason}`);
      await onChanged();
```

**(g) `LivePrintRow.tsx`** (`"use client"`) — `PrintCard`'s body (`:873-1311`) with the drag/drop handlers, `postAccept` and its three 409 confirms, `acceptAllAgreed`, `acceptLine`, `acceptCandidate`, `unaccept`, `handleDrop` moved verbatim; the header is the state chip + `windowText` + `ladderText` + `goStatusText`; then, in order: `<GoControls>`, `<IrPageField>`, `<PrepareStatus>`, the road outcomes (`print.coverage` plus `print.documentRoads` when present), the `<ScrollFade>` sheet of `<LineRow>`s, `<FirstPassRead …/>` (unchanged, one mount), and `<PrintOutputs … promote={…} />`. `router.refresh()` after a promote is kept (`:990`) — the Hub's server rows carry `actual_value`.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/dashboard/
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E 'live-print|LivePrintRow' ; echo "tsc filtered done"
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run build
```
Expected: PASS; `print-watch-panel.test.ts` green with all 61 assertions and no assertion text edited; `npm run build` clean (this wave's client-boundary gate — `live-print/*` imports only `@/lib/print-watch/{types,reconcile}`, `@/lib/format`, `@/lib/privacy/*`, `@/lib/http/apiFetch` and the two local dirs).

- [ ] **Step 5: Commit**

```bash
cat > /tmp/msg-f8.txt <<'MSG'
feat(today): the print card becomes LivePrintRow, with a paste box, an IR-page field, prepare status and the output buttons

Moves the panel's pure helpers and LineRow out of PrintWatchPanel (which task 10
deletes) and adds what the panel never had: the go paste box (contract §4), the
first UI for PUT /api/print-watch/sources, a prepare-step line that calls a
pending ir_baseline "waiting" rather than stuck, and the three output buttons,
which render only when slice E's `outputs` is on the payload. Also: a retired
line now says so instead of reading as pending, and the Δ column is masked
whenever the bogey it is computed against is.
MSG
git commit app/dashboard/today/live-print app/dashboard/today/LivePrintRow.tsx app/api/print-watch/sources/route.ts tests/dashboard/print-watch-panel.test.ts tests/dashboard/first-pass-read.test.ts tests/dashboard/live-print-row.test.ts tests/api/print-watch-sources-get.test.ts -F /tmp/msg-f8.txt
```

---
### Task 9: `EarningsHubLive` + the Hub wiring + the expansion siblings (M-F3, M-F6, M-F12, M-F13)

**Files:**
- Create: `app/dashboard/today/EarningsHubLive.tsx`
- Modify: `app/dashboard/today/EarningsHub.tsx` — the initial cockpit payload, the provider wrapper, the two slot insertions
- Modify: `app/dashboard/today/EarningsRowChips.tsx` — read the live cockpit row from context instead of taking it as a prop
- Test: `tests/dashboard/earnings-hub-live.test.ts`

**Interfaces:**
- Consumes: `createPollController`, `deriveExpansion`, `snapshotOf`, `readManual`, `writeManual`, the wire types (Task 6); `LivePrintRow` (Task 8); `StageChipStrip` (Task 7); `apiFetch`; `HOT_POLL_MS`/`COOL_POLL_MS`/`ENSURE_INTERVAL_MS` (Task 8's helpers); `buildCockpitPayload` + `decorateCockpitIntel` (server side only, in `EarningsHub`).
- Produces:

```ts
// app/dashboard/today/EarningsHubLive.tsx  ("use client")
export interface HubLiveValue {
  printByEvent: Record<number, PrintStatusEntry>;
  cockpitByEvent: Record<number, CockpitRowWire>;
  prepareByEvent: Record<number, PrepareStepWire[]>;
  nowMs: number;
  statusError: string | null;
  onChanged: () => Promise<void>;
}
export function useHubLive(): HubLiveValue | null;   // null outside the provider — every consumer degrades to its server props
export default function EarningsHubLive(props: {
  weekOf: string;
  eventIds: number[];
  initialCockpit: CockpitPayloadWire | null;
  children: React.ReactNode;
}): JSX.Element;
export function LivePrintSlot(props: { eventId: number; symbol: string; armed: boolean }): JSX.Element | null;
/** Exported for the test: the cadence rule in one pure function. */
export function statusIntervalMs(prints: PrintStatusEntry[]): number;
/** Pure: the status entries whose event is NOT in the rendered week. */
export function orphanPrints(printByEvent: Record<number, PrintStatusEntry>, eventIds: number[]): PrintStatusEntry[];
/** Presentational — takes its rows as a prop so it is render-testable. */
export function LivePrintsOutsideWeek(props: { prints: PrintStatusEntry[] }): JSX.Element | null;
```

#### Amendments (Codex round 1) — Task 9

Findings folded here: **7** (= **F-S2** — the cockpit stream), **8** (= **F-S1** — the open-state effect), **9** (hidden tab at mount; `parsed` cools before the read starts), **14** (= **F-S10** — a live print outside the Hub's week is unreachable). This block REPLACES `statusIntervalMs`, the cockpit stream, the controller start, and `LivePrintSlot`'s two effects in Step 3; ADDS `orphanPrints` + `LivePrintsOutsideWeek`; and REPLACES three tests while adding four.

**(a) Codex 9(b) — `parsed` must stay hot until the read is under way.** Slice D schedules the first-pass read five seconds AFTER the parse lands. Cooling to 30 s the instant the state becomes `parsed` therefore hides the read for up to half a minute at the busiest moment on the desk's day. Replacement:

```ts
export function statusIntervalMs(prints: PrintStatusEntry[]): number {
  const hot = prints.some((p) => {
    // The window is open or the document is in hand: the sheet is moving.
    if (p.state === "window_open" || p.state === "acquired") return true;
    // A go press is queued or claimed: the acquisition is happening now.
    if (p.goRequest?.status === "queued" || p.goRequest?.status === "claimed") return true;
    // A read is generating.
    if (p.activeRead != null) return true;
    // Just parsed, no read yet, nothing has failed: slice D arms the read five
    // seconds from the parse, so one IS coming. Going cool here would show a
    // filled sheet with no read for 30 s and look like a stall. Once a read is
    // done, or an attempt has failed or capped, this goes cool again.
    if (p.state === "parsed" && p.read == null && p.lastAttempt == null) return true;
    return false;
  });
  return hot ? HOT_POLL_MS : COOL_POLL_MS;
}
```

**(b) Codex 7 / F-S2 — the cockpit stream keyed on its trigger.** The `firstCockpitRun` ref is DELETED; the controller now says why it is calling (Task 6). Replacement for the `"cockpit"` stream's `run`:

```ts
          run: async (signal, fetchImpl, trigger) => {
            // A server-rendered payload is the freshest thing there is, so the
            // first run after mount fetches NOTHING. A mutation (`refresh`) or a
            // tab coming back (`resume`) wants a cheap read. Only the 60-second
            // timer POSTs, because POST is the intel REFRESH — it writes, and
            // is TTL-guarded server-side at one refresh per event per 30 min.
            if (trigger === "start" && initialCockpit) return null;
            const url = `/api/earnings/cockpit?weekOf=${encodeURIComponent(weekOf)}`;
            const init: RequestInit =
              trigger === "timer"
                ? { signal, method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }
                : { signal };
            const res = await fetchImpl(url, init);
            const data = (await res.json().catch(() => null)) as { success?: boolean; data?: CockpitPayloadWire } | null;
            if (!res.ok || !data?.success || !data.data) throw new Error("cockpit refresh failed");
            return data.data;
          },
```

`onChanged` is unchanged in intent and now correct in effect: `refresh("status")` + `refresh("cockpit")` issues an immediate GET, not a POST.

**(c) Codex 9(a) — do not start a controller in a hidden tab.** Replacement for the two lines after the controller is built:

```tsx
    controllerRef.current = controller;
    // A tab restored in the background must not fire four requests nobody is
    // looking at. Create the controller either way — the visibility handler
    // below is what starts it — but only START when the tab is actually shown.
    if (document.visibilityState !== "hidden") controller.start();
```

(`resume()` returns early when already running and `pause()` is idempotent, so a tab that mounts hidden and is then shown starts exactly once through `onVisibility`.)

**(d) Codex 8 / F-S1 — the open-state effect.** Replacement for `LivePrintSlot`'s second effect:

```tsx
  useEffect(() => {
    if (!print) {
      // The print left the payload entirely (expired out of the window,
      // re-homed by a merge, or the event was deleted). Nothing about the old
      // subject may survive into whatever appears next.
      prevRef.current = null;
      setManual(null);
      setOpen(false);
      return;
    }
    const next = snapshotOf(print);
    // CAPTURED BEFORE the ref is overwritten — this is the whole bug: comparing
    // against prevRef.current AFTER writing it makes the comparison trivially
    // true, so a re-homed row kept the old print's open state.
    const prevPrintId = prevRef.current?.printId ?? null;
    const decided = deriveExpansion(prevRef.current, next, manual);
    prevRef.current = next;
    setOpen((was) => nextOpenState({ was, decided, prevPrintId, next, manual }));
  }, [print, manual]);
```

(`nextOpenState` joins the `./hub-live/expansion` import.)

**(e) Codex 14 / F-S10 — a live print outside the Hub's week.** Slice C's forced window can put a print on an event from last week (a date correction, a late filer). Today would then hold a live print with no row, no expansion and no recovery surface — and the panel that used to show it is deleted in Task 10. The cheap version: one block after the week's rows.

`LivePrintSlot` gains a `symbol: string` prop (the Hub row already has `e.symbol`, and the orphan block reads it off the status entry) — it is the only way the armed-but-no-print path can render `IrPageField`, which is keyed by symbol.

```tsx
/** Pure, so the selection is testable without a DOM. A status entry with no
 *  `eventId` cannot be placed at all and is left out rather than guessed at. */
export function orphanPrints(
  printByEvent: Record<number, PrintStatusEntry>,
  eventIds: number[],
): PrintStatusEntry[] {
  const inWeek = new Set(eventIds);
  return Object.values(printByEvent)
    .filter((p) => p.eventId !== undefined && !inWeek.has(p.eventId))
    .sort((a, b) => a.printId - b.printId);
}

/**
 * Live prints whose event is not in the week the Hub is showing (Codex round 1
 * #14 / F-S10). Without this they are invisible from Today: the print-watch
 * panel that used to list every active print is deleted in task 10, and the
 * Hub only renders the current week's events.
 *
 * A SEPARATE top-level component (never nested — the remount trap), taking its
 * rows as a prop so `react-dom/server` can render it in a test. The status
 * payload carries no event DATE (verified: the status route's mapper returns
 * printId, eventId, symbol, state, sources, coverage, the window fields,
 * goRequest, lines, documents, documentRoads, read, activeRead, lastAttempt,
 * callouts — and F may not edit that route, E owns it), so the line names the
 * symbol, the state and the effective window instead of inventing a date.
 */
export function LivePrintsOutsideWeek({ prints }: { prints: PrintStatusEntry[] }) {
  if (prints.length === 0) return null;
  return (
    <div className="mt-3 border-t border-edge px-5 py-3">
      <h3 className="text-[11px] uppercase tracking-wider text-ink-faint whitespace-nowrap!">
        Live prints outside this week
      </h3>
      {prints.map((p) => (
        <div key={p.printId} className="mt-2">
          <p className="text-[12px] font-mono text-ink-dim">
            {p.symbol} · {printStateLabel(p.state).text}
            {p.effectiveWindow ? ` · ${windowText(p.effectiveWindow, Date.now())}` : ""}
          </p>
          <LivePrintSlot eventId={p.eventId!} symbol={p.symbol} armed />
        </div>
      ))}
    </div>
  );
}
```

(`printStateLabel` and `windowText` come from `./live-print/helpers`, already imported for the cadence constants.) Rendered inside the provider, after the server children:

```tsx
  return (
    <HubLiveContext.Provider value={value}>
      {children}
      <LivePrintsOutsideWeek prints={orphanPrints(printByEvent, eventIds)} />
    </HubLiveContext.Provider>
  );
```

The expansion rule needs no special case: a forced window is a transition into `window_open`, so an orphan opens by itself exactly like an in-week row.

`EarningsHub.tsx`'s two slot insertions gain the symbol:

```tsx
                      <LivePrintSlot eventId={e.id} symbol={e.symbol} armed={e.worksheetArmed} />
```

**(f) Tests.** REPLACE the first `statusIntervalMs` case (a bare `parsed` entry is now HOT) and ADD five:

```ts
describe("statusIntervalMs — polling follows the print state (spec §4.6)", () => {
  it("is cool with nothing live and nothing pending", () => {
    expect(statusIntervalMs([])).toBe(30_000);
    expect(statusIntervalMs([entry(), entry({ printId: 2, state: "expired" })])).toBe(30_000);
  });
  it("stays HOT on a fresh parse until a read exists or an attempt has failed (Codex 9b)", () => {
    expect(statusIntervalMs([entry({ state: "parsed" })])).toBe(2_000);
    expect(statusIntervalMs([entry({ state: "parsed", read: { id: 1 } as never })])).toBe(30_000);
    expect(statusIntervalMs([entry({ state: "parsed", lastAttempt: { id: 2 } as never })])).toBe(30_000);
  });
  // …the three original hot cases (window_open/acquired, go request, activeRead) stand.
});

describe("orphanPrints (Codex 14 / F-S10)", () => {
  it("keeps only the prints whose event is not in the rendered week, oldest print first", () => {
    const byEvent = { 10: entry({ printId: 1, eventId: 10 }), 99: entry({ printId: 7, eventId: 99, symbol: "XMPL2" }) };
    expect(orphanPrints(byEvent, [10]).map((p) => p.printId)).toEqual([7]);
    expect(orphanPrints(byEvent, [10, 99])).toEqual([]);
  });
  it("skips an entry with no eventId rather than guessing where it belongs", () => {
    expect(orphanPrints({ 0: entry({ printId: 3, eventId: undefined }) }, [10])).toEqual([]);
  });
});

describe("LivePrintsOutsideWeek render", () => {
  it("renders nothing when every live print is in the week", () => {
    expect(renderToStaticMarkup(createElement(LivePrintsOutsideWeek, { prints: [] }))).toBe("");
  });
  it("names the orphan's symbol and state under its own header", () => {
    const html = renderToStaticMarkup(
      createElement(LivePrintsOutsideWeek, { prints: [entry({ printId: 7, eventId: 99, symbol: "XMPL2", state: "window_open" })] }),
    );
    expect(html).toContain("Live prints outside this week");
    expect(html).toContain("XMPL2");
  });
});
```

and in the `EarningsHubLive source` describe, REPLACE the `initialCockpit` case and ADD three:

```ts
  it("issues NO cockpit request on start when the server handed a payload down (Codex 7 / F-S2)", () => {
    expect(src).toMatch(/trigger === "start" && initialCockpit/);
    expect(src).toMatch(/return null;/);
    expect(src).not.toMatch(/firstCockpitRun/);
  });
  it("POSTs the cockpit only on the timer tick, and GETs on refresh and resume", () => {
    expect(src).toMatch(/trigger === "timer"\s*\?\s*\{ signal, method: "POST"/);
  });
  it("does not start the controller in a tab that mounts hidden (Codex 9a)", () => {
    expect(src).toMatch(/document\.visibilityState !== "hidden"\) controller\.start\(\)/);
  });
  it("captures the previous print id BEFORE overwriting the ref (Codex 8 / F-S1)", () => {
    expect(src).toMatch(/const prevPrintId = prevRef\.current\?\.printId \?\? null;/);
    const capture = src.indexOf("const prevPrintId");
    const write = src.indexOf("prevRef.current = next");
    expect(capture).toBeLessThan(write);
    expect(src).toMatch(/nextOpenState\(/);
  });
  it("renders the outside-the-week block as a top-level sibling of the children", () => {
    expect(src).toMatch(/\{children\}\s*<LivePrintsOutsideWeek/);
  });
```

The `EarningsHub wiring` describe gains: `expect(src).toMatch(/<LivePrintSlot eventId=\{e\.id\} symbol=\{e\.symbol\}/)`. `tests/dashboard/earnings-hub-live.test.ts` gains `createElement` (react), `renderToStaticMarkup` (react-dom/server) and `orphanPrints` / `LivePrintsOutsideWeek` to its imports; `LivePrintsOutsideWeek` renders outside the provider on purpose — `useHubLive()` returns `null` there, so each `LivePrintSlot` falls to its armed-with-no-print line, which is exactly what the header + symbol assertions read.

- [ ] **Step 1: Write the failing test**

`tests/dashboard/earnings-hub-live.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { statusIntervalMs } from "@/app/dashboard/today/EarningsHubLive";
import type { PrintStatusEntry } from "@/app/dashboard/today/hub-live/types";

const entry = (o: Partial<PrintStatusEntry> = {}): PrintStatusEntry =>
  ({ printId: 1, eventId: 10, symbol: "XMPL1", state: "scheduled", sources: {}, coverage: [], lines: [], ...o });

describe("statusIntervalMs — polling follows the print state (spec §4.6)", () => {
  it("is cool with nothing live", () => {
    expect(statusIntervalMs([])).toBe(30_000);
    expect(statusIntervalMs([entry(), entry({ printId: 2, state: "parsed" })])).toBe(30_000);
  });
  it("is hot while any print is window_open or acquired", () => {
    expect(statusIntervalMs([entry({ state: "window_open" })])).toBe(2_000);
    expect(statusIntervalMs([entry({ state: "expired" }), entry({ printId: 2, state: "acquired" })])).toBe(2_000);
  });
  it("is hot while a go request is queued or claimed, even on a scheduled print", () => {
    expect(statusIntervalMs([entry({ goRequest: { id: 1, status: "queued", attempts: 0, requestedAt: "t", result: null } })])).toBe(2_000);
    expect(statusIntervalMs([entry({ goRequest: { id: 1, status: "claimed", attempts: 1, requestedAt: "t", result: null } })])).toBe(2_000);
    expect(statusIntervalMs([entry({ goRequest: { id: 1, status: "done", attempts: 1, requestedAt: "t", result: [] } })])).toBe(30_000);
  });
  it("is hot while a first-pass read is generating", () => {
    expect(statusIntervalMs([entry({ state: "parsed", activeRead: { id: 1, status: "generating", nonce: 0, attempts: 1, claimed_at: "t" } })])).toBe(2_000);
  });
});

describe("EarningsHubLive source", () => {
  const src = readFileSync("app/dashboard/today/EarningsHubLive.tsx", "utf8");
  it("owns EVERY poll the deleted components owned: status, ensure, cockpit, prepare", () => {
    expect(src).toMatch(/\/api\/print-watch\/status/);
    expect(src).toMatch(/\/api\/print-watch\/ensure/);
    expect(src).toMatch(/\/api\/earnings\/cockpit\?weekOf=/);
    expect(src).toMatch(/\/api\/earnings\/worksheet\?eventIds=/);
  });
  it("pauses on a hidden tab and resumes on visible", () => {
    expect(src).toMatch(/visibilitychange/);
    expect(src).toMatch(/document\.visibilityState === "hidden"/);
    expect(src).toMatch(/\.pause\(\)/);
    expect(src).toMatch(/\.resume\(\)/);
  });
  it("keeps the mutation re-fetch the cockpit had (the earnings-data-changed event)", () => {
    expect(src).toMatch(/earnings-data-changed/);
  });
  it("uses the shared controller rather than its own timers", () => {
    expect(src).toMatch(/createPollController/);
    expect(src).not.toMatch(/setInterval\(/);
  });
  it("skips the initial cockpit GET when the server already handed one down", () => {
    expect(src).toMatch(/initialCockpit/);
  });
  it("never defines a component inside another component's body (remount trap)", () => {
    const inner = src.split("export default function EarningsHubLive")[1] ?? "";
    expect(inner).not.toMatch(/\n\s+function [A-Z]/);
  });
});

describe("EarningsHub wiring", () => {
  const src = readFileSync("app/dashboard/today/EarningsHub.tsx", "utf8");
  it("computes the initial cockpit payload server-side for the Hub's week", () => {
    expect(src).toMatch(/buildCockpitPayload\(db, new Date\(\), \{ weekOf \}\)/);
    expect(src).toMatch(/decorateCockpitIntel\(db, /);
  });
  it("wraps the rows in the client provider and drops one slot per row on BOTH layouts", () => {
    expect(src).toMatch(/<EarningsHubLive/);
    expect(src.match(/<LivePrintSlot\b/g)).toHaveLength(2);   // desktop + mobile
  });
  it("keeps the expansion inside the two responsive containers so globals.css still switches it", () => {
    // .earnings-hub-desktop / .earnings-hub-mobile are the md: + rail switch
    // (app/globals.css). A slot outside them would render twice at 1280.
    const desktop = src.slice(src.indexOf("earnings-hub-desktop"), src.indexOf("earnings-hub-mobile"));
    expect(desktop).toMatch(/<LivePrintSlot/);
  });
  it("adds no grid span — the row containers are blocks, the grid is per row", () => {
    expect(src).not.toMatch(/col-span-full/);
  });
  it("still exports force-dynamic behaviour through the page, and keeps its db reads", () => {
    expect(src).toMatch(/from "@\/lib\/db"/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/dashboard/earnings-hub-live.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`app/dashboard/today/EarningsHubLive.tsx` (`"use client"`) — the shape, with the four streams and the context:

```tsx
"use client";

/**
 * The Hub's ONE live controller (spec §4.6). Everything the Earnings Cockpit
 * and the Live Print Watch panel used to poll separately is polled here once:
 * print-watch status (hot 2s / cool 30s), the 60-second /ensure that keeps the
 * watcher lease alive, the cockpit intel refresh, and the worksheet prepare
 * rows. It is a PROVIDER around server-rendered rows: EarningsHub keeps its db
 * reads, and the per-row client leaves below read this context.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import apiFetch from "@/lib/http/apiFetch";
import { createPollController, type PollController } from "./hub-live/poll-controller";
import { deriveExpansion, readManual, snapshotOf, writeManual, type ExpansionSnapshot, type ManualToggle } from "./hub-live/expansion";
import { COOL_POLL_MS, ENSURE_INTERVAL_MS, HOT_POLL_MS } from "./live-print/helpers";
import LivePrintRow from "./LivePrintRow";
import type { CockpitPayloadWire, CockpitRowWire, PrepareStepWire, PrintStatusEntry } from "./hub-live/types";

export function statusIntervalMs(prints: PrintStatusEntry[]): number {
  const hot = prints.some(
    (p) =>
      p.state === "window_open" ||
      p.state === "acquired" ||
      p.goRequest?.status === "queued" ||
      p.goRequest?.status === "claimed" ||
      p.activeRead != null,
  );
  return hot ? HOT_POLL_MS : COOL_POLL_MS;
}

export interface HubLiveValue { /* as declared in Interfaces */ }
const HubLiveContext = createContext<HubLiveValue | null>(null);
export function useHubLive(): HubLiveValue | null { return useContext(HubLiveContext); }

export default function EarningsHubLive({ weekOf, eventIds, initialCockpit, children }: {
  weekOf: string; eventIds: number[]; initialCockpit: CockpitPayloadWire | null; children: React.ReactNode;
}) {
  const [prints, setPrints] = useState<PrintStatusEntry[]>([]);
  const [cockpit, setCockpit] = useState<CockpitPayloadWire | null>(initialCockpit);
  const [prepare, setPrepare] = useState<Record<number, PrepareStepWire[]>>({});
  const [statusError, setStatusError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // The scheduler reads live state through a ref, never through its own deps —
  // the useCallback render-loop trap this project has hit before.
  const printsRef = useRef<PrintStatusEntry[]>([]);
  const controllerRef = useRef<PollController | null>(null);
  const idsKey = eventIds.join(",");

  useEffect(() => {
    const controller = createPollController({
      fetchImpl: (input, init) => apiFetch(input, init),
      streams: [
        {
          name: "status",
          intervalMs: () => statusIntervalMs(printsRef.current),
          run: async (signal, fetchImpl) => {
            const res = await fetchImpl("/api/print-watch/status", { signal });
            const data = (await res.json().catch(() => null)) as
              { success?: boolean; data?: { prints: PrintStatusEntry[] }; error?: string } | null;
            if (!res.ok || !data?.success || !data.data) throw new Error(data?.error ?? `Server returned ${res.status}`);
            return data.data.prints;
          },
          onResult: (rows) => { printsRef.current = rows as PrintStatusEntry[]; setPrints(rows as PrintStatusEntry[]); setStatusError(null); },
          onError: (err) => setStatusError(err instanceof Error ? err.message : "Could not reach the server for print-watch status."),
        },
        {
          name: "ensure",
          intervalMs: () => ENSURE_INTERVAL_MS,
          run: async (signal, fetchImpl) => {
            const res = await fetchImpl("/api/print-watch/ensure", {
              method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal,
            });
            const data = (await res.json().catch(() => null)) as { success?: boolean; error?: string } | null;
            // Non-blocking by design — /ensure only arms the watcher loops. But
            // a silently, persistently failing /ensure means the watcher has
            // stopped being kept alive, so it reaches the console.
            if (!res.ok || !data?.success) console.warn(`print-watch: /ensure failed (${data?.error ?? `server returned ${res.status}`})`);
            return null;
          },
          onResult: () => undefined,
        },
        {
          name: "cockpit",
          intervalMs: () => 60_000,
          run: async (signal, fetchImpl) => {
            // POST is the intel refresh (TTL-guarded server-side); the first
            // run is a GET only when the server handed nothing down.
            const first = firstCockpitRun.current;
            firstCockpitRun.current = false;
            const res = await fetchImpl(`/api/earnings/cockpit?weekOf=${encodeURIComponent(weekOf)}`, {
              signal, ...(first && initialCockpit ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }),
            });
            const data = (await res.json().catch(() => null)) as { success?: boolean; data?: CockpitPayloadWire } | null;
            if (!res.ok || !data?.success || !data.data) throw new Error("cockpit refresh failed");
            return data.data;
          },
          onResult: (p) => setCockpit(p as CockpitPayloadWire),
          onError: () => undefined,   // keep the last good payload; never blank a rendered chip strip
        },
        {
          name: "prepare",
          intervalMs: () => 60_000,
          run: async (signal, fetchImpl) => {
            if (eventIds.length === 0) return {};
            const res = await fetchImpl(`/api/earnings/worksheet?eventIds=${eventIds.join(",")}`, { signal });
            const data = (await res.json().catch(() => null)) as
              { success?: boolean; data?: { prepare: Record<number, PrepareStepWire[]> } } | null;
            if (!res.ok || !data?.success || !data.data) throw new Error("prepare read failed");
            return data.data.prepare;
          },
          onResult: (p) => setPrepare(p as Record<number, PrepareStepWire[]>),
          onError: () => undefined,
        },
      ],
    });
    controllerRef.current = controller;
    controller.start();
    const onVisibility = () => (document.visibilityState === "hidden" ? controller.pause() : controller.resume());
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      controller.stop();
      controllerRef.current = null;
    };
  }, [weekOf, idsKey]);   // eventIds is passed by value; idsKey is its stable identity
```

plus: `firstCockpitRun` as a `useRef(true)`; an `onChanged` callback that calls `controllerRef.current?.refresh("status")` and `refresh("cockpit")` and resolves; a `window.addEventListener("earnings-data-changed", …)` effect that calls `onChanged` (the same idiom `EarningsRowChips.tsx:317` already dispatches); a one-second `nowMs` tick that runs ONLY while `cockpit?.nextRelease` exists (the cockpit's own rule, `EarningsCockpit.tsx:167-171`); the drop-swallowing `dragover`/`drop` document listeners moved from `PrintWatchPanel.tsx:790-798` (a file dropped outside a card still navigates the tab away otherwise); and the memoised context value with `printByEvent`, `cockpitByEvent` (from `cockpit?.rowsByEvent ?? {}`), `prepareByEvent`, `nowMs`, `statusError`, `onChanged`.

`LivePrintSlot` is a SEPARATE top-level component in the same file (never nested — the remount rule):

```tsx
export function LivePrintSlot({ eventId, armed }: { eventId: number; armed: boolean }) {
  const live = useHubLive();
  const print = live?.printByEvent[eventId] ?? null;
  const prevRef = useRef<ExpansionSnapshot | null>(null);
  const [manual, setManual] = useState<ManualToggle>(null);
  const [open, setOpen] = useState(false);

  // The stored preference is per PRINT, so it is read when the print id
  // appears or changes — never once at mount.
  useEffect(() => {
    if (!print) return;
    const stored = readManual(print.printId);
    setManual(stored === null ? null : { printId: print.printId, open: stored });
  }, [print?.printId]);

  useEffect(() => {
    if (!print) { prevRef.current = null; return; }
    const next = snapshotOf(print);
    const decided = deriveExpansion(prevRef.current, next, manual);
    prevRef.current = next;
    setOpen((was) => (manual && manual.printId === next.printId ? manual.open : decided || (was && prevRef.current?.printId === next.printId)));
  }, [print, manual]);

  if (!armed && !print) return null;
  …
}
```
— the toggle is a full-word text button that writes the preference:
```tsx
      <button
        type="button"
        onClick={() => { const next = !open; setManual({ printId: print.printId, open: next }); writeManual(print.printId, next); setOpen(next); }}
        className="text-[11px] font-mono underline text-ink-dim hover:text-ink"
      >
        {open ? "collapse" : "expand"}
      </button>
```
and when `open`, it renders `<div className="px-5 py-3 border-b border-edge"><LivePrintRow print={print} prepareSteps={live?.prepareByEvent[eventId]} onChanged={live!.onChanged} /></div>`. When `armed` but there is no print yet, it renders a single line: `armed — the watch window opens automatically ahead of the release` plus the expand control (which shows `IrPageField` and `PrepareStatus` only).

`EarningsHub.tsx` changes (server):
```tsx
import { buildCockpitPayload } from "@/lib/queries/earnings-cockpit";
import { decorateCockpitIntel } from "@/lib/queries/earnings-intel";
import EarningsHubLive, { LivePrintSlot } from "./EarningsHubLive";
…
  // The first paint carries the stage chips with no client fetch (spec §4.6).
  // Both calls are read-only: decorateCockpitIntel reads already-computed intel
  // rows; the refresh that WRITES them stays on the route's POST.
  const initialCockpit = buildCockpitPayload(db, new Date(), { weekOf });
  decorateCockpitIntel(db, initialCockpit);
```
the returned `<section>` body is wrapped:
```tsx
      <EarningsHubLive weekOf={weekOf} eventIds={enriched.map((e) => e.id)} initialCockpit={initialCockpit}>
        …the existing desktop and mobile containers, unchanged…
      </EarningsHubLive>
```
and each row gains its sibling INSIDE the responsive container (M-F13 — a plain block, no span):
```tsx
                  {byDay.get(day)!.map((e) => (
                    <div key={e.id}>
                      <DesktopRow event={e} />
                      <LivePrintSlot eventId={e.id} armed={e.worksheetArmed} />
                    </div>
                  ))}
```
(and the identical shape around `<MobileCard>`).

`EarningsRowChips.tsx`: replace the Task-7 `cockpitRow` prop with `const live = useHubLive(); const cockpitRow = live?.cockpitByEvent[eventId] ?? null;` so the Hub does not have to thread it through the server rows. The component still renders correctly when `live` is `null` (outside the provider) or the row is absent.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/dashboard/ tests/queries/earnings-cockpit.test.ts tests/repo/
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run build
```
Expected: PASS; `npm run build` clean. `next build` is the real gate here: the provider is a client component receiving server children, and any server-only import that leaked into the client tree fails it.

- [ ] **Step 5: Commit**

```bash
cat > /tmp/msg-f9.txt <<'MSG'
feat(today): one live controller for the Hub, with the print as an in-place row expansion

EarningsHubLive is a client provider around the Hub's server-rendered rows: one
generation-ordered status poll whose cadence follows the print state, the 60s
/ensure, the cockpit refresh for the whole week and the worksheet prepare read,
all paused while the tab is hidden. Each row drops a LivePrintSlot that decides
expansion from state TRANSITIONS and remembers a manual override per print.
MSG
git commit app/dashboard/today/EarningsHubLive.tsx app/dashboard/today/EarningsHub.tsx app/dashboard/today/EarningsRowChips.tsx tests/dashboard/earnings-hub-live.test.ts -F /tmp/msg-f9.txt
```

---
### Task 10: Today page removals, the one-line snapshot, the Analysis cards, and the two deletions (M-F1, M-F2, M-F11)

**Files:**
- Modify: `app/dashboard/today/page.tsx` (486 lines — read it whole first)
- Move: `app/dashboard/today/SignificantMovesCard.tsx` → `app/dashboard/components/SignificantMovesCard.tsx` (`git mv`; its only code importer is `today/page.tsx:15`, and it has ZERO test importers — verified repo-wide)
- Modify: `app/dashboard/analysis/page.tsx` — the diagnostics branch, between `:313` and `:315`
- Delete: `app/dashboard/today/EarningsCockpit.tsx`, `app/dashboard/today/PrintWatchPanel.tsx`
- Test: `tests/dashboard/today-page-blocks.test.ts`

**Why the deletions live HERE and not in Task 9.** `page.tsx` imports both files (`:21`, `:23`). Deleting them in Task 9 would break `npm run build` at the W3 boundary. They go in the same commit that removes the imports.

#### Amendments (Codex round 1) — Task 10

Finding folded here: **15** (first half — the one-line snapshot can display a guessed figure and an unwrapped count). This block REPLACES the computation and the markup in Step 3a, and ADDS three assertions to Step 1's test.

**The bug.** `moved.reduce(...)` over an empty array is `0`, so a morning before any prior close has landed — or a portfolio of names IBKR has no previous session for — renders `$0.00 today` in the `text-up` colour. That is not a small number; it is a WRONG number, presented as a measurement. And `{holdings.length - moved.length} without a prior close` renders a portfolio-derived count as a bare integer, outside `<Count>`, which privacy mode would leave standing.

Replacement for the computation:

```tsx
  // One-line snapshot (spec §2: "Portfolio snapshot shrinks to one line"). The
  // per-name list lives on Accounts now. A null today_gain is UNKNOWN, never
  // zero: names with no prior close contribute to neither sum, and when NO name
  // has one there is no move to report at all — `null`, not `0`.
  const moved = holdings.filter((h) => h.today_gain !== null);
  const todayGain = moved.length === 0 ? null : moved.reduce((sum, h) => sum + (h.today_gain ?? 0), 0);
  const priorClose =
    todayGain === null ? null : moved.reduce((sum, h) => sum + h.current_value, 0) - todayGain;
  const todayPct =
    todayGain !== null && priorClose !== null && priorClose > 0 ? (todayGain / priorClose) * 100 : null;
```

Replacement for the figure span and the missing-price note inside the `<div className="flex items-baseline gap-3 …">`:

```tsx
            {todayGain === null ? (
              <span
                className="font-mono tabular-nums text-ink-faint"
                title="no prior-close prices yet — today's move is unavailable"
              >
                —
              </span>
            ) : (
              <span className={`font-mono tabular-nums ${todayGain >= 0 ? "text-up" : "text-down"}`}>
                <Money value={todayGain} signed />
                {todayPct !== null && (
                  <> (<Pct value={todayPct} digits={2} signed />)</>
                )}
              </span>
            )}
            {moved.length < holdings.length && (
              <span
                className="text-[11px] text-ink-faint"
                title="Names with no prior close are excluded from today's move"
              >
                <Count value={holdings.length - moved.length} /> without a prior close
              </span>
            )}
```

ADD to the `"collapses IBKR today to one line"` test in Step 1:

```ts
    // Codex 15: nothing on this line may render a figure the app does not have.
    expect(today).toMatch(/todayGain === null \? null : moved\.reduce/);
    expect(today).toContain("no prior-close prices yet — today's move is unavailable");
    expect(today).toMatch(/<Count value=\{holdings\.length - moved\.length\} \/>/);
    // Every $, % and count on the line sits inside a privacy wrapper: the only
    // braces in that block that reach a number are the wrappers' own props.
    const line = today.slice(today.indexOf("IBKR today — one line"), today.indexOf("</section>", today.indexOf("IBKR today — one line")));
    expect(line).not.toMatch(/\{todayGain\}|\{todayPct\}|\{holdings\.length\}(?!\s*\/>)/);
```

- [ ] **Step 1: Write the failing test**

`tests/dashboard/today-page-blocks.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PrivacyProvider } from "@/lib/privacy/context";
import { MomentumPulse } from "@/app/dashboard/components/MomentumPulse";
import type { MomentumPulse as MomentumPulseData } from "@/lib/compute/momentum-spread";

const today = readFileSync("app/dashboard/today/page.tsx", "utf8");
const analysis = readFileSync("app/dashboard/analysis/page.tsx", "utf8");

describe("Today keeps only the blocks the spec keeps (§2 ruling, §4.6)", () => {
  it("no longer imports or renders Alerts, Nearby Levels, Momentum Pulse, Significant Moves, the cockpit or the print panel", () => {
    for (const gone of [
      "getAlerts", "NearbyLevelsCard", "getLevelsNearPrice", "MomentumPulse",
      "computeMomentumPulse", "SignificantMovesCard", "EarningsCockpit", "PrintWatchPanel",
    ]) {
      expect(today, `Today still references ${gone}`).not.toContain(gone);
    }
    expect(today).not.toMatch(/AlertGroup|EnrichedAlert|triggeredToday/);
  });
  it("still renders the header, the portfolio strip, releases, the Hub, the chat button and the one-line IBKR snapshot, in that order", () => {
    expect(today).toContain("<EarningsHub");
    expect(today).toContain("<OpenChatButton");
    expect(today).toContain("<TodayReleases");
    const order = ["Portfolio", "<TodayReleases", "<EarningsHub", "<OpenChatButton", "IBKR today"].map((s) => today.indexOf(s));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((i) => i > -1)).toBe(true);
  });
  it("collapses IBKR today to one line: count, signed money, percent, refresh, and a link to Accounts", () => {
    expect(today).toMatch(/<Count\b/);
    expect(today).toMatch(/<Money[^>]*signed/);
    expect(today).toMatch(/<Pct\b/);
    expect(today).toContain("<IbkrRefreshButton");
    expect(today).toContain("/dashboard/accounts");
    // The per-name list is gone: no map over holdings and no per-row security link.
    expect(today).not.toMatch(/holdings\.map\(/);
  });
  it("keeps force-dynamic and renders an EmptySection-equivalent rather than nothing when there is no IBKR account", () => {
    expect(today).toMatch(/export const dynamic = "force-dynamic"/);
    expect(today).toMatch(/No IBKR account/);
  });
  it("lets releases span the full row now that the momentum tile is gone", () => {
    expect(today).not.toMatch(/md:grid-cols-2[^]*TodayReleases/);
  });
});

describe("the two deleted components are really gone (M-F11)", () => {
  it("EarningsCockpit.tsx and PrintWatchPanel.tsx no longer exist and nothing imports them", () => {
    expect(existsSync("app/dashboard/today/EarningsCockpit.tsx")).toBe(false);
    expect(existsSync("app/dashboard/today/PrintWatchPanel.tsx")).toBe(false);
  });
  it("SignificantMovesCard moved to app/dashboard/components", () => {
    expect(existsSync("app/dashboard/components/SignificantMovesCard.tsx")).toBe(true);
    expect(existsSync("app/dashboard/today/SignificantMovesCard.tsx")).toBe(false);
  });
});

describe("Analysis diagnostics gains the two moved cards (§4.6 bullet 2)", () => {
  it("imports and renders both, above TrustStrip and below the view toggle", () => {
    expect(analysis).toContain("SignificantMovesCard");
    expect(analysis).toContain("computeMomentumPulse");
    const toggle = analysis.indexOf("<AnalysisViewToggle");
    const cards = analysis.indexOf("<SignificantMovesCard");
    const pulse = analysis.indexOf("<MomentumPulse");
    const trust = analysis.lastIndexOf("<TrustStrip");
    expect(toggle).toBeGreaterThan(-1);
    expect(cards).toBeGreaterThan(toggle);
    expect(pulse).toBeGreaterThan(toggle);
    expect(trust).toBeGreaterThan(cards);
    expect(trust).toBeGreaterThan(pulse);
  });
  it("computes the pulse itself, because MomentumPulse is prop-driven while SignificantMovesCard self-loads", () => {
    expect(analysis).toMatch(/computeMomentumPulse\(db\)/);
    expect(analysis).toMatch(/<MomentumPulse pulse=/);
    expect(analysis).toMatch(/<SignificantMovesCard \/>/);
  });
});

describe("MomentumPulse still renders in its new home", () => {
  const pulse: MomentumPulseData = {
    spreads: {
      mtum_vs_spy: { return30d: 1.2, return5d: 0.4, return1d: 0.1 },
      spmo_vs_spy: { return30d: 1.0, return5d: 0.3, return1d: 0.1 },
      usmv_vs_spy: { return30d: -0.4, return5d: -0.1, return1d: 0.0 },
    },
    status: "leading", trigger: "5d", reason: "Momentum is leading over five days.", asOf: "2026-09-10",
  };
  it("renders the headline status and reason from a fixture, and its own empty state for null", () => {
    const html = renderToStaticMarkup(createElement(PrivacyProvider, null, createElement(MomentumPulse, { pulse })));
    expect(html).toContain("Momentum is leading over five days.");
    const empty = renderToStaticMarkup(createElement(PrivacyProvider, null, createElement(MomentumPulse, { pulse: null })));
    expect(empty).not.toBe("");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/dashboard/today-page-blocks.test.ts`
Expected: FAIL — the page still carries every removed block.

- [ ] **Step 3a: `today/page.tsx`**

Delete: the imports at `:5` (`getAlerts`), `:6` (`getLevelsNearPrice`), `:13` (`NearbyLevelsCard`), `:15` (`SignificantMovesCard`), `:19` (`MomentumPulse`), `:20` (`computeMomentumPulse`), `:21` (`EarningsCockpit`), `:23` (`PrintWatchPanel`); the `EnrichedAlert` interface (`:28-34`); `triggeredToday` (`:49-53`); `formatPriceSource` (`:55-58`, only the Alerts block used it — grep to confirm before deleting); the alert enrichment and the split (`:91-114`); `nearbyLevels` (`:117`); `momentumPulse` (`:172`); the JSX at `:270` (`<MomentumPulse>`), `:273-282` (cockpit + Hub comment + panel — KEEP `<EarningsHub />`), `:284-334` (the Alerts + Levels grid), `:337` (`<SignificantMovesCard />`), the holdings `<ul>` (`:365-424`); and the `AlertGroup` function (`:431-486`). Also drop the now-unused imports `LevelAlert` (from the `@/lib/types` import — keep `CalendarEvent`), `PrivateText`, `formatUSDPrecise` and `Shares`; keep `Money`, `Pct` and add `Count`.

The releases row loses its second column:
```tsx
      {/* ── Today's releases (full width — the momentum tile moved to
              Analysis · Diagnostics, spec §4.6) ── */}
      {releases.length > 0 ? (
        <TodayReleases releases={releases} mode={releasesMode} />
      ) : (
        <section className="rounded-xl bg-panel p-4">
          <h2 className="text-sm font-medium text-ink">Releases</h2>
          <p className="mt-2 text-[13px] text-ink-faint">No upcoming releases scheduled.</p>
        </section>
      )}
```

The IBKR block becomes one line. Compute it beside `latestPriceDate` (both sums skip `today_gain === null`, and the percent's base is the prior close, i.e. value minus today's move):

```tsx
  // One-line snapshot (spec §2: "Portfolio snapshot shrinks to one line"). The
  // per-name list lives on Accounts now. Names with no prior close contribute
  // to neither sum — a null today_gain is "unknown", never zero.
  const moved = holdings.filter((h) => h.today_gain !== null);
  const todayGain = moved.reduce((sum, h) => sum + (h.today_gain ?? 0), 0);
  const priorClose = moved.reduce((sum, h) => sum + h.current_value, 0) - todayGain;
  const todayPct = priorClose > 0 ? (todayGain / priorClose) * 100 : null;
```

```tsx
      {/* ── IBKR today — one line (spec §4.6). The per-name list is on Accounts. ── */}
      <section className="rounded-xl bg-panel p-4 card-elev">
        {!ibkrAccount ? (
          <p className="text-[14px] text-ink-faint">No IBKR account set up yet.</p>
        ) : holdings.length === 0 ? (
          <p className="text-[14px] text-ink-faint">
            No holdings found. Connect TWS or import IBKR activity files.
          </p>
        ) : (
          <div className="flex items-baseline gap-3 flex-wrap text-[13px]">
            <h2 className="text-sm font-medium text-ink whitespace-nowrap!">IBKR today</h2>
            <span className="text-ink-dim font-mono tabular-nums">
              <Count value={holdings.length} /> names
            </span>
            <span className={`font-mono tabular-nums ${todayGain >= 0 ? "text-up" : "text-down"}`}>
              <Money value={todayGain} signed />
              {todayPct !== null && (
                <> (<Pct value={todayPct} digits={2} signed />)</>
              )}
            </span>
            {moved.length < holdings.length && (
              <span
                className="text-[11px] text-ink-faint"
                title="Names with no prior close are excluded from today's move"
              >
                {holdings.length - moved.length} without a prior close
              </span>
            )}
            <IbkrRefreshButton latestPriceDate={latestPriceDate} />
            <Link href="/dashboard/accounts" className="ml-auto text-[13px] text-gold-ink hover:text-gold">
              Accounts &rarr;
            </Link>
          </div>
        )}
      </section>
```

- [ ] **Step 3b: the move and the Analysis page**

```bash
git mv app/dashboard/today/SignificantMovesCard.tsx app/dashboard/components/SignificantMovesCard.tsx
```
Fix its own relative imports (it uses `@/app/dashboard/components/...` absolute paths at `:17-19`, so nothing changes) and update the header comment from "Today-tab surface" to "Analysis · Diagnostics surface".

`app/dashboard/analysis/page.tsx` — add the imports and the block between `:313` and `:315`:

```tsx
import { SignificantMovesCard } from "../components/SignificantMovesCard";
import { MomentumPulse } from "../components/MomentumPulse";
import { computeMomentumPulse } from "@/lib/compute/momentum-spread";
```

```tsx
      <AnalysisViewToggle currentView="diagnostics" scope={params.scope} />

      {/* ── Moved off Today by live print v2 (spec §4.6): the two market-wide
              read-outs belong with the other diagnostics, not on the earnings
              surface. SignificantMovesCard self-loads from the db singleton;
              MomentumPulse is prop-driven, so the pulse is computed here. ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
        <SignificantMovesCard />
        <MomentumPulse pulse={computeMomentumPulse(db)} />
      </div>

      <TrustStrip scope={scope} />
```

- [ ] **Step 3c: delete the two components**

```bash
git rm app/dashboard/today/EarningsCockpit.tsx app/dashboard/today/PrintWatchPanel.tsx
```
Then confirm nothing is left behind:
```bash
grep -rn "EarningsCockpit\|PrintWatchPanel" app/ lib/ tests/ scripts/ workers/ || echo "no references"
```
Expected: `no references` (the docs are updated in Task 11; a docs hit is fine, a code hit is not).

- [ ] **Step 4: Run the tests to verify they pass**

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/dashboard/ tests/repo/
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E 'today/page|analysis/page|SignificantMoves' ; echo "tsc filtered done"
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run build
```
Expected: PASS; the filtered tsc grep prints only its marker; `npm run build` clean.

- [ ] **Step 5: Commit**

```bash
cat > /tmp/msg-f10.txt <<'MSG'
feat(today): one earnings surface — alerts, levels, momentum and significant moves leave

Today keeps the header, the portfolio strip, releases, the Hub, the chat button
and a one-line IBKR snapshot that links to Accounts; the cockpit and the print
panel are deleted (their content is the Hub row and its expansion now), and the
two market-wide read-outs move to Analysis · Diagnostics.
MSG
git commit app/dashboard/today/page.tsx app/dashboard/components/SignificantMovesCard.tsx app/dashboard/today/SignificantMovesCard.tsx app/dashboard/today/EarningsCockpit.tsx app/dashboard/today/PrintWatchPanel.tsx app/dashboard/analysis/page.tsx tests/dashboard/today-page-blocks.test.ts -F /tmp/msg-f10.txt
```

---
### Task 11: Docs, the verification loop, and the sandbox E2E runbook

**Files:** `docs/reference/ui-structure.md`, `docs/reference/earnings-pipeline.md`, `docs/DECISIONS.md`, `docs/plans/TODO.md`, `CLAUDE.md`. Otherwise this task produces evidence, not code.

#### Amendments (Codex round 1) — Task 11

Findings folded here: **16** (the E2E starts from a live database without proving sanitisation), **17(a)** (the hidden-tab check does not cover every stream), **17(c)** (no full pass after E and F are combined), **F-S4** (the keyboard callout accept cannot happen on a secretless sandbox), **F-S5** (the pasted URL must be a public https host). This block ADDS four DECISIONS bullets to Step 1, REPLACES E2E steps 4, 5 and 11 and the privacy paragraph in Step 3, and REPLACES Step 4.

**(a) Step 1 — four DECISIONS bullets to append after the existing ten:**

```markdown
- **Extra-metric identity is the id; the protocol is add + remove (R-F2).** A spec whose id is absent from the stored row is an add; a stored id absent from the submission is a remove, and its line retires-with-evidence at the next recompile. There is no create/retire/revise operations API and no persisted-id diff: re-minting an id costs a line's CONTINUITY, never its evidence. The modal therefore hydrates stored ids rather than minting fresh ones, and takes a pasted id at add-row time so the same metric can be defined on a second sheet.
- **The watcher's sheet write is serialised against the recompile by one immediate transaction, not by version fencing (R-F4).** `writeLines` compiled, read, reconciled and upserted as four statements, so a sweep process holding the watcher lease could compile before a bogeys POST and write after it — silently reverting a definition the desk had just changed. Both sides now use `.immediate()`, and SQLite orders them either way round.
- **Evidence on a print line is EVERY persisted trace** — `accepted`, `value`, `value_high`, `snippet`, `audit_json`, or a non-empty `candidates_json` — and a retire-rename carries the print's `print_watch_candidate_archive` rows with it. An archived candidate is NOT evidence on the line: a line whose only trace is an archive row was never measured, is deleted, and its archive rows keep the old id.
- **F needs no allowlist entry for slice E's email-state guard (R-F12).** That guard scans `lib/**` and `app/api/**`; `app/dashboard/**` is exempt by design because the UI carries the state words as TypeScript union members and display keys, not as SQL. Recorded in the cross-slice contract §1.
```

Also amend the ui-structure bullet about the Hub: add a sentence that a live print whose event is NOT in the rendered week appears under a **Live prints outside this week** block at the foot of the Hub, so a forced window on a stale event is never invisible from Today.

**(b) Step 3 — E2E step 4 REPLACEMENT (F-S5).** `validatePublicUrl` accepts https only, with a globally-routable pinned-DNS host, so a `file://`, a `127.0.0.1` or the fixture's local path can never travel the URL road:

> 4. **Paste box.** Two halves, both against the real routes.
>    - **URL road.** Paste a real, public `https://www.sec.gov/Archives/...` EX-99 exhibit from a PAST filing for a company that is NOT in the portfolio (public data about a listed company; no portfolio specifics reach the log, and the exact URL is written into the gitignored worktree ledger, not here). **The sandbox fetches it for real** — that is the point: it exercises `validatePublicUrl`, the SSRF pin and the HTML road end to end. The go row appears and the road outcomes list it.
>    - **File road.** Pick the gitignored fixture (`data/private/e2e/`) through the native `<input type="file">` → the print reaches `parsed` and the sheet fills.
>    - **Refusal.** A URL carrying a `token=` query key is REFUSED with slice C's own message, rendered verbatim; a `http://` URL is refused with "only https:// links are accepted".

**(c) Step 3 — E2E step 5 REPLACEMENT (F-S4).** The sandbox runs with `ANTHROPIC_API_KEY=sk-ant-test-dummy-not-real`, so slice D's first-pass read can never complete and there are no callouts to accept. Seed them:

> 5. **Keyboard-only callout accept.** The sandbox has no working model key, so the read is SEEDED rather than generated — the accept path is what this step tests, and it is the real route:
>    ```sql
>    -- against $S/vanguard-e2e-f.db, with <print> = XMPL1's print id
>    INSERT INTO print_watch_reads (print_id, fingerprint, nonce, status, facts_json, prose_json, model_id, created_at, updated_at)
>      VALUES (<print>, 'e2e-fixture', 0, 'done', '[]', '{"read":["Seeded for the E2E."],"call_watch":["a","b","c"]}', 'e2e-fixture', datetime('now'), datetime('now'));
>    INSERT INTO print_watch_callouts (print_id, read_id, label, label_norm, unit, value, snippet, doc_sha256, evidence_sha256, state, verifier_version)
>      SELECT <print>, id, 'Seeded metric one', 'seeded metric one', 'usd', 275000000, 'seeded snippet one', 'e2e', 'e2e', 'proposed', 1 FROM print_watch_reads WHERE print_id = <print>;
>    -- …and a second row with 'Seeded metric two'.
>    ```
>    (column names are read off migration 091 at run time, not typed from memory — the shape above is the shape slice D shipped, and the runbook step is "match the live schema, then insert".) Then, with the row expanded, **Tab** to a callout's `accept` button and press **Enter**: the state flips to `accepted` through the real `POST /api/print-watch/callouts/accept`. No pointer is used at any point in this step.

**(d) Step 3 — E2E step 11 REPLACEMENT (17a).** The controller owns four streams; asserting one of them proves a quarter of the rule:

> 11. **Hidden-tab abort — all four streams.** Switch to another tab for 30 seconds. In the network panel, filtered to this origin, there must be ZERO requests to `/api/print-watch/status`, `/api/print-watch/ensure`, `/api/earnings/cockpit` and `/api/earnings/worksheet` for the whole interval — a 30-second hidden window is longer than the hot status cadence (2 s) and than the other three (60 s), so a leak of any stream shows up. On return, each of the four fires EXACTLY ONCE immediately (the cockpit's return call is a GET, not a POST — check the method), and then resumes its own cadence. Record the four counts before, during and after.
>
>    Also assert the mount case: load `/dashboard/today` in a background tab (open it with ⌘-click and do not focus it) and confirm no request from any of the four for 30 seconds; focus it and see one of each.

**(e) Step 3 — privacy paragraph REPLACEMENT (16).** Seeding `XMPL` rows into a VACUUM copy of the live database does not remove the real accounts, totals, holdings and earnings events that copy contains, so a Today screenshot can still capture portfolio specifics:

> **Privacy procedure (BINDING).** The DB copy is the real database and is never sanitised — it also never leaves the machine. Instead:
> 1. **Privacy mode ON in the app for every screenshot.** Toggle it before the first capture and assert it is on (the masked glyphs are visible in the shot itself); the run is void otherwise. This is the same mechanism the product ships, so the screenshots also double as a privacy-mode check of the new surfaces.
> 2. **Captures stay in the gitignored worktree ledger** (`../vanguard-skin-print-v2-f/qa/` — gitignored) and are copied to `docs/private/` by the session. Nothing under `docs/` that is tracked, and nothing in a commit message, carries a screenshot or a log line.
> 3. **The scan is executable, against a real list.** `data/private/e2e/canary.txt` (gitignored, written by the session — real tickers held or watched, plus the account names) drives it:
>    ```bash
>    grep -i -F -f data/private/e2e/canary.txt "$S/e2e-server-f.log" && echo "CANARY HIT — do not retain" || echo "log clean"
>    ```
>    and every retained screenshot is eyeballed for `XMPL*` symbols only. A canary hit means the capture is deleted, not redacted.
> The canary file's PATH is named here; its CONTENTS never appear in this plan, in a commit, or in any tracked file.

**(f) Step 4 REPLACEMENT (17c) — the merge session's integration gate.**

> - [ ] **Step 4: Merge order, the integration gate, and the deploy**
>
> F adds no migration, so there is no cutover on F's side; E carries 092. Whichever of E and F merges first, the second rebases. The shared files are `docs/DECISIONS.md`, `docs/plans/TODO.md` and `docs/reference/earnings-pipeline.md`, each of which takes BOTH sections (the C/D precedent).
>
> **After BOTH have merged, on `main`, before any deploy — every one of these, in order:**
> 1. `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run` — the FULL suite, not a filter. Record the count and compare with the `main`@`31d0e84f` baseline plus each branch's own delta.
> 2. `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsc --noEmit -p tsconfig.json` — clean. This is where a shape F assumed and E shipped differently surfaces as a type error rather than as a blank panel at 16:05.
> 3. `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run build` — clean. The client-boundary gate for the combined tree.
> 4. E's 092 rehearsal on a VACUUM copy of the live DB (E's own plan owns the procedure) — F contributes nothing but must not deploy ahead of it.
> 5. **The E2E on `main`, with `outputs` present.** Re-run steps 1, 2, 3, 9 and 10 of the runbook above, plus the integration checks F could not run on its own branch: the three output buttons render; a disabled `Send recap now` shows E's gate copy verbatim; `Print sheet` returns its road and page count; a `delivery_unknown` audit row renders the warn `?` chip with the contract's exact title AND is CLICKABLE, opening the stored body (contract §1, R-E14).
> 6. Only then run the project's `electron:deploy` chain from `main`. **Do not run `wrangler dev` in the main checkout before that deploy**, and do not run git branch/worktree cleanup while it builds.
>
> If any of 1–5 fails, the deploy does not happen and the failure goes back to whichever slice owns the file — not patched in the merge session.

- [ ] **Step 1: Docs**

`docs/reference/ui-structure.md` — under "Tab Structure", replace the Today description with the block list and add the expansion:

```markdown
- **Today (post live-print-v2 slice F, 2026-09-04)** renders exactly six blocks, in order: the date header (+ Vanguard snapshot age, price-quality chip, Week ahead link) · the Portfolio strip · Today's releases (full width) · the **Earnings Hub** · the chat button · a ONE-LINE IBKR today snapshot (`<Count> names · <Money signed> today (<Pct>) · refresh · Accounts →`; the per-name list lives on `/dashboard/accounts`). Alerts, Nearby Levels, the Earnings Cockpit and the Live Print Watch panel are GONE from Today; Significant Moves and Momentum Pulse moved to **Analysis · Diagnostics** (above `TrustStrip`, below the view toggle).
- **Hub row expansion.** An armed row renders a full-width sibling under its `DesktopRow` / `MobileCard` — `LivePrintRow`: print header, go controls + paste box, IR-page field, prepare status, road outcomes, the sheet, the first-pass read, and the output buttons. It is a plain BLOCK sibling, not a grid span: `.earnings-hub-desktop` is a block container and the CSS grid lives on each row. Auto-expansion is transition-based (`hub-live/expansion.ts`) — entering `window_open`/`acquired`, a newly forced window, or a new go request; a first load never auto-opens, and a manual `expand`/`collapse` overrides and is remembered per print in `localStorage["vgs:print-expanded:<printId>"]`.
- **At 1280 with the chat rail open the Hub is already the MOBILE layout** (`app/globals.css`: `768px–1535px` + `html[data-chat-rail="open"]` hides `.earnings-hub-desktop`). The rail reserves `--chat-rail-width` (480px, 720px expanded) as `padding-right` on `.chat-rail-reserve` at ≥1280px, leaving ~752px. The expansion lives inside both responsive containers, so it follows that switch with no CSS of its own.
- **One controller.** `EarningsHubLive` is a client provider wrapping the Hub's SERVER-rendered rows; it owns every poll (status hot 2s / cool 30s following the print state, `/ensure` every 60s, the cockpit refresh, the worksheet prepare read), drops responses whose generation is stale, and aborts everything while the tab is hidden.
```

`docs/reference/earnings-pipeline.md` — append a section after §"Armed coverage + prepare steps (v2 slice A)":

```markdown
## Extra metric lines and recompilation (v2 slice F)

`earnings_bogeys.extra_metrics_json` holds the desk's own metric definitions:
`[{ id: <uuid v4, immutable>, label, definition, unit: usd|per_share|pct|count,
kind: point|range, period: Q|NQ_guide|FY_guide, basis: gaap|non_gaap|na,
consensus?, whisper? }]`. `lib/print-watch/extra-metrics.ts` parses them strictly
(unknown keys rejected, label ≤ 60, definition ≤ 300) and is CLIENT-SAFE, so the
bogeys modal validates with the same code the route validates with.

`compileContracts` emits one line per merged id, `metric_id = x_<uuid>_<period>`,
`pct` mapped to the contract unit `percent`. **The same id on two bogey sheets
must agree on unit, kind, period and basis**; when it does not, NEITHER compiles
and the id comes back in the additive `conflicts` key, which
`GET /api/earnings/bogeys` republishes as `extraMetricConflicts` and the modal
renders as a banner. Numbers merge first-non-null by bogey rowid.

`recompileContracts(db, printId)` (`lib/print-watch/recompile.ts`) is explicit and
runs in ONE immediate transaction; `POST` and `DELETE /api/earnings/bogeys` call
it for the event's live print (any state but `expired`/`disarmed`). Per existing
line: same semantics → update `contract_json`/`expected_json` in place; semantic
change (unit / kind / basis / period) WITH evidence (`value IS NOT NULL`, a
non-empty `candidates_json`, or `state = 'accepted'`) → the old row is RENAMED to
`<metric_id>~retired~<n>` and booked `retired`, and a fresh `pending` line is
inserted; semantic change without evidence → overwritten in place; no longer
compiled → retired if it has evidence, else deleted; newly compiled → inserted
`pending`. The rename is forced by the `(print_id, metric_id)` primary key. It is
safe because `upsertLines` never deletes and never touches a `metric_id` absent
from its input, and `~retired~` ids are never compiled — so no later parse can
resurrect or clobber one. `retractDocument` already treats `retired` like
`accepted`; `sheetLineKeys` reads COMPILED contracts (so a retired line never
suppresses a callout) and `isContradictedAccepted` short-circuits on any state
that is not `accepted`.
```

`docs/DECISIONS.md` — append:

```markdown
## 2026-09-04 — Live print v2 slice F (Today layout, Hub live controller, extra metric lines)

- **Today is one earnings surface.** Alerts, Nearby Levels, the cockpit and the print panel leave the page; Significant Moves and Momentum Pulse move to Analysis · Diagnostics; the IBKR block becomes one line linking to Accounts. Reason: spec §2 ruling and §4.6.
- **`EarningsHubLive` is a client PROVIDER around server-rendered rows**, not a client re-implementation of the Hub. `EarningsHub` keeps its eight `db` reads and adds the cockpit payload; per-row client leaves (`LivePrintSlot`, `EarningsRowChips`) read one shared context. Reason: it is the only shape that keeps the db on the server and still gives every row one poll.
- **The expansion is a plain block sibling, not a grid span.** `.earnings-hub-desktop` is `display:block`; the CSS grid lives on each row. `col-span-full` there would be inert.
- **At 1280 with the rail open the Hub is already the mobile layout** (`globals.css`, 768–1535px + `data-chat-rail="open"`). The desktop-grid-with-rail case starts at 1536px.
- **Auto-expansion is transition-based and first-load-silent**; a manual toggle wins and is remembered per PRINT, so a date correction that re-homes a row onto a new print does not inherit the old preference.
- **Retirement is a RENAME.** `print_watch_lines`' PK is `(print_id, metric_id)`, so a retired row takes `<metric_id>~retired~<n>`. Slice B declared the `retired` state and never produced one; `recompileContracts` is its first producer.
- **The prepare status line reads `GET /api/earnings/worksheet?eventIds=`,** because `GET /api/print-watch/status` exposes no prepare state. A `pending` `ir_baseline` on a symbol with no stored IR page is the normal resting state and renders as "waiting on an IR page", never as stuck.
- **`PUT /api/print-watch/sources` gets its first UI** (`IrPageField`) — slice B shipped the route with no caller.
- **The Δ column is masked whenever the bogey is** (TODO ruling (ii), 2026-09-04): a masked bogey beside a clear Δ is recoverable by division.
- **The bogey content-column TODO closes with a guard, not a merge:** `CONTENT_COLUMNS` gains `extra_metrics_json` and `tests/repo/bogey-content-lists-agree.test.ts` pins `CONTENT_COLUMNS ⊆ BOGEY_CONTENT`. The two lists keep their different meanings.
- **F adds no migration** (spec §5) and never edits `lib/earnings/**`, `lib/calendar/**`, `lib/digest/**`, any `app/api/print-watch/**` route, or the Worker — slice E owns those and the two slices share no file.
```

`docs/plans/TODO.md`:
- close item `:81` ("Single-source the bogey content columns — slice F's call"): mark `[x]` with the result — `CONTENT_COLUMNS` gained `extra_metrics_json`; the lists are NOT merged (different meanings, each already pinned to the schema); the drift the item worried about is now impossible via `tests/repo/bogey-content-lists-agree.test.ts`.
- in the slice-B deferred-minors item `:88`, mark the "slice F's Hub must not render it as stuck" clause done and name `PrepareStatus`.
- in the slice-D deferred-minors item `:91`, mark (a) done and name `live-print/LineRow.tsx`.
- add F's own residuals (from the self-review below).

`CLAUDE.md` — replace the first UI Structure bullet's Today sentence:

```markdown
- 6 desktop tabs: Today | Accounts | Analysis | Research | Charts | Import. **Today is six blocks: header · Portfolio strip · Releases · Earnings Hub · chat button · a one-line IBKR snapshot** (alerts, nearby levels, the cockpit and the print panel were removed by live print v2 slice F; Significant Moves + Momentum Pulse live on Analysis · Diagnostics). An armed Hub row expands in place into `LivePrintRow`. Chat is a persistent right rail ≥1280px (Cmd+J); Cmd+K is global ticker-jump; NotesAmbient overlay on Cmd+;. Old routes redirect.
```

- [ ] **Step 2: The verification loop**

```bash
cd ../vanguard-skin-print-v2-f
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run verify:changed
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run verify:smoke
ANTHROPIC_API_KEY=sk-ant-test-dummy-not-real PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsc --noEmit -p tsconfig.json
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run build
```

Expected: `verify:changed` and `verify:smoke` green; the full suite green (record the file/test counts and compare against the `main`@`31d0e84f` baseline — report the delta, and note that the panel test's 61 assertions must still be present, just re-pointed); `tsc --noEmit` clean; `npm run build` clean. The worktree has no `.env.local`, so the dummy key satisfies the key-presence tests and no test can reach a provider.

- [ ] **Step 3: Sandbox E2E on `:3094`**

Recipe (from `~/.claude/projects/-Users-Yitzi-code-vanguard-skin/memory/reference_worktree_e2e_sandbox_recipe.md`, with the port changed — slice E uses 3095):

```bash
S=/private/tmp/claude-502/-Users-Yitzi-code-vanguard-skin/<session>/scratchpad
sqlite3 /Users/Yitzi/code/vanguard-skin/data/vanguard.db "VACUUM INTO '$S/vanguard-e2e-f.db'"
cd /Users/Yitzi/code/vanguard-skin && PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx scripts/mint-qa-session.ts --db "$S/vanguard-e2e-f.db" > "$S/e2e-session-f.env"
cd ../vanguard-skin-print-v2-f && nohup env -i HOME="$HOME" USER="$USER" TMPDIR="$TMPDIR" \
  PATH=/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/bin:/bin \
  DATABASE_PATH="$S/vanguard-e2e-f.db" \
  APP_EXTRA_HOSTS=localhost:3094,127.0.0.1:3094 APP_EXTRA_ORIGINS=http://localhost:3094,http://127.0.0.1:3094 \
  ANTHROPIC_API_KEY=sk-ant-test-dummy-not-real CRON_SHARED_SECRET=e2e-dummy ELECTRON_SERVICE_CRED=e2e-dummy \
  npm run dev -- -p 3094 > "$S/e2e-server-f.log" 2>&1 & echo $! > "$S/e2e-server-f.pid"
```
Readiness: grep the log for `Ready`, then `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3094/login` → 200. The browser agent sets `vgs_session` + `vgs_csrf` via `document.cookie` on `/login`, then navigates. `curl` POSTs need `-H 'Origin: http://127.0.0.1:3094'`, the two cookies and `x-csrf-token`. Kill by the saved PID afterwards; the DB copy is discarded.

**Fixture (SYNTHETIC ids only).** Seed five earnings events `XMPL1`..`XMPL5`, one per weekday of the current Hub week, if the copy lacks them; give `XMPL1` (today, AMC, `release_time` a few minutes ahead) a bogey sheet with a revenue consensus and guidance text, and arm its worksheet. A synthetic press release lives under the gitignored `data/private/e2e/`.

Run through ONE `agent-browser` subagent at widths **390, 768, 1280 (chat rail OPEN)** and **1440**:

1. **Removals.** `/dashboard/today` shows exactly six blocks; no Alerts card, no "Levels @ 5%", no Momentum tile, no Significant Moves, no "Earnings day" cockpit strip, no "Live Print Watch" panel. The IBKR line reads `IBKR today · N names · ±$X today (±Y%) · ↻ · Accounts →` and the link lands on `/dashboard/accounts`.
2. **Hub chips for the full week.** Every weekday row carries its stage chips (a Thursday row's `pre`/`rec` chips render), proving `rowsByEvent` covers the week and not just today.
3. **Expansion on the transition.** With `XMPL1` collapsed, force the window: `POST /api/print-watch/go {"eventId":<XMPL1>}`. Within one hot poll (≤ 3 s) the row expands by itself. Reload: it stays open only because the manual preference is absent and the state is now `window_open`… so instead assert the two rules separately — (a) collapse it manually, reload, it is STILL collapsed (`vgs:print-expanded:<printId>` = `0`); (b) clear that key, drive the print to `parsed` (drop the fixture release), reload — it does NOT auto-open.
4. **Paste box.** Paste the fixture's URL → the go row appears and the road outcomes list it. Then pick the fixture FILE through the native input → `parsed`, and the sheet fills. A URL carrying a `token=` query key is REFUSED with the server's own message (slice C's rule), rendered verbatim.
5. **Keyboard-only callout accept.** With the read done, Tab to a callout's `accept` button and press Enter; the state flips to `accepted`. No pointer is used.
6. **Two hot prints.** Arm and force `XMPL2` as well; both rows expand, and the network panel shows ONE `/api/print-watch/status` request per tick (not two).
7. **`PrintOutputs`.** On this branch the status payload has no `outputs`, so no buttons render and no error appears — that is the pass. (The three-button rendering is covered by the render test's `outputs` fixture; the live buttons are verified in the merge session once E lands.)
8. **Analysis.** `/dashboard/analysis?view=diagnostics` shows Significant Moves and Momentum Pulse side by side above the trust strip; at 390 they stack.
9. **Extra metrics.** In `XMPL1`'s bogeys modal add a metric on sheet A, and the SAME id on sheet B with a different unit → the conflict banner names the id and `unit`, and no `x_…` line appears on the sheet. Fix sheet B to agree → save → one `x_<uuid>_Q` line appears (recompile ran on the POST). Accept it with a value, then change its `basis` → the old row shows `retired — definition changed` and a fresh pending line sits beside it.
10. **Layout.** At 1280 with the rail OPEN: `document.documentElement.scrollWidth === document.documentElement.clientWidth` (no horizontal page scroll), the Hub renders its MOBILE card layout (`.earnings-hub-desktop` computed `display: none`), and the expansion sits under the card. At 1440 with the rail open the desktop grid is still hidden (the CSS band ends at 1535px) — record that as expected, not a bug. At 390 the bottom nav is unobscured and the paste box's file input opens the picker.
11. **Hidden-tab abort.** Switch to another tab for 30 s; the network panel shows no `/api/print-watch/status` requests while hidden and exactly one immediately on return.

Screenshots and the server log are privacy-scanned before anything is committed: `grep -iE "<real ticker>|<account name>" "$S/e2e-server-f.log"` must be empty, and every screenshot kept must show only `XMPL*` symbols.

- [ ] **Step 4: Merge order and the deploy**

F adds no migration, so there is no cutover. Whichever of E and F merges first, the second rebases; the shared files are `docs/DECISIONS.md`, `docs/plans/TODO.md` and `docs/reference/earnings-pipeline.md`, each of which takes BOTH sections (the C/D precedent). After BOTH have merged, the merge session verifies the integration end to end on `main`: `outputs` appears on the status payload, the three buttons render, `Send recap now` returns its outcome verbatim, and a `delivery_unknown` audit row renders the warn `?` chip with the contract's title. Then run the project's `electron:deploy` chain from `main`. **Do not run `wrangler dev` in the main checkout before that deploy** and do not run git branch/worktree cleanup while it builds.

- [ ] **Step 5: Commit**

```bash
cat > /tmp/msg-f11.txt <<'MSG'
docs(print-watch): slice F — Today's block list, the Hub expansion, extra metric lines and recompilation

Records the layout rules a future change has to respect (the expansion is a
block sibling, not a grid span; at 1280 with the rail open the Hub is already
the mobile layout), the retirement-by-rename invariant, and closes the bogey
content-column TODO with a containment guard.
MSG
git commit docs CLAUDE.md -F /tmp/msg-f11.txt
```

---

## Self-review (run after writing; findings fixed inline)

**1. Spec coverage.**

| Spec clause | Task |
|---|---|
| §4.6 "remove the Alerts block and `NearbyLevelsCard`; remove `EarningsCockpit` and `PrintWatchPanel` as blocks; snapshot to one line" | 10 |
| §4.6 "`SignificantMovesCard` and `MomentumPulse` move to the top of the Analysis `diagnostics` view" | 10 |
| §4.6 "`EarningsHub` renders server rows plus a client controller `EarningsHubLive` owning every poll" | 9 (M-F12) |
| §4.6 "print-watch status (hot 2s, cool 30s)", "the 60-second `/ensure`", "the cockpit's intel refresh", "the mutation-event re-fetch" | 9 (`statusIntervalMs`, four streams) |
| §4.6 "generation counter; older responses are dropped; requests abort on unmount and when the tab is hidden, resume on visibility" | 6 (`createPollController`) |
| §4.6 "`buildCockpitPayload` is widened to the Hub's week" | 5 |
| §4.6 "The email tri-state helpers move with the chips" | 7 |
| §4.6 "An armed row renders a full-width sibling below the desktop grid row or the mobile card: `LivePrintRow` with the moved `PrintCard`/`LineRow`, the IR-page field, the prepare status, the go button and paste box, the road outcomes, the read, the callouts, and the buttons" | 8 (every named piece) + 9 (the sibling) |
| §4.6 "Auto-expansion is transition-based …; `parsed` does not auto-expand on load; a manual toggle overrides, remembered per print in `localStorage`" | 6 (`deriveExpansion`), 9 (`LivePrintSlot`) |
| §4.6 "Polling follows the print state" | 9 (`statusIntervalMs`, incl. go-request and active-read) |
| §4.6 "Callout accept is keyboard-operable" | 8 (test: no `div onClick`; the control is a real `<button>`) |
| §4.6 "Mobile: same controller; paper printing stays Mac-side. Chat rail open at 1280 must not reflow the expansion" | 8 (native file input), 11 E2E step 10, M-F14 |
| §4.7 `extra_metrics_json` shape, `x_<uuid>_<period>`, agreement on unit/kind/period/basis, "the modal reports a conflict and neither compiles", "numbers merge first-non-null" | 1, 2, 4 |
| §4.7 "When a semantic field changes on an `id` with evidence, the existing line is marked `retired` (evidence preserved) and a new line is compiled. `recompileContracts(db, printId)` is explicit and transactional." | 3 (+ 4 for the trigger) |
| §5 "**F**: none" | Global Constraints; no migration anywhere in this plan |
| §6 routes | 4 (`bogeys` GET/POST/DELETE), 5 (`cockpit` GET/POST); F adds NO route |
| §8 F-line: "removed blocks; chips for the full week; generation-ordered responses; abort on hidden tab; transition-based expansion; toggle persistence; two hot prints; correction during expansion; keyboard callout acceptance; desktop 1280 with rail open and mobile widths; Analysis diagnostics renders the moved cards; extra-metric conflicts and retirement" | 10; 5+11(2); 6; 6; 6; 6; 9+11(6); 6 ("a print id CHANGE … is treated as a first load"); 8+11(5); 11(10); 10; 2/3/4/11(9) |
| Contract §1 `delivery-unknown` | 7 |
| Contract §2 `PrintOutputs` renders only when present | 8 |
| Contract §3 outcomes rendered verbatim | 8 |
| Contract §4 paste-box body | 8 |
| Contract §5 additive `conflicts` | 2 |

No spec clause is unassigned.

**2. Placeholder scan.** No "TBD", "TODO", "implement later", "add appropriate error handling", "similar to Task N" or "write tests for the above". Every code step carries real code. One place delegates deliberately and says exactly what to do: Task 8's verbatim helper move names each symbol and its source line rather than reprinting 550 lines of unchanged code (the three CHANGES inside the move are printed in full). *Amended by the Codex round 1 fold:* the second such place — Task 5 Step 3's "check `cockpitRowsToIntelEvents`, then STOP and escalate" — is GONE. The check was run during the fold, the answer was "yes, it reads lanes + carryover", and Task 5's Amendments block prints the replacement helper, so nothing is left for the implementer to decide.

**3. Type consistency.** `ExtraMetricSpec` / `parseExtraMetrics` / `detectExtraMetricConflicts` / `mergeExtraMetrics` / `extraMetricId` / `extraMetricUnitToContractUnit` are defined once in Task 1 and used with those exact signatures in Tasks 2, 3 and 4. `compileContracts` returns `{ contracts, expected, conflicts }` in Task 2 and is consumed with that shape in Task 3. `RecompileReport` is defined in Task 3 and returned by the route in Task 4. `CockpitPayload.rowsByEvent` (Task 5) is `CockpitPayloadWire.rowsByEvent` on the client (Task 6) and read as `cockpitByEvent` in Task 9. `PrintStatusEntry`, `GoRequestWire`, `PrintOutputsWire` and `PrepareStepWire` are declared once in Task 6's `hub-live/types.ts` and imported by Tasks 7, 8 and 9. `ExpansionSnapshot` / `ManualToggle` / `deriveExpansion` / `snapshotOf` / `readManual` / `writeManual` (Task 6) are used with those shapes in Task 9. `StreamSpec` / `PollController` (Task 6) are used in Task 9. `chipFor` / `stageChips` / `StageChipStrip` (Task 7) are used in Tasks 7 and 9. `presentState` gains the `retired` case in Task 8 and is asserted there. `LivePrintRow(props: { print, prepareSteps, onChanged })` (Task 8) is rendered with exactly those props in Task 9. `PrintOutputs` takes `{ printId, outputs, onChanged, promote }` in Task 8 and is rendered with all four inside `LivePrintRow`.

**4. Residuals for the Codex round — after the round-1 fold.**

CLOSED by the fold: **(a)** → Codex 10 / F-S3 (`allCockpitRows` now walks `rowsByEvent`, so the whole week is decorated and re-ensured; Task 5's escalation is deleted). **(d)** → F-S8 (`promote` is in `PrintOutputs`' Interfaces block and in every test call; the control is still owned by `LivePrintRow`, which is now stated rather than implied). **(g)** → Codex 14 / F-S10 (`LivePrintsOutsideWeek` renders one slot per orphan at the foot of the Hub, and the E2E's step 3 forced-window case reaches it).

Still open, recorded for the user:
- (b) The initial cockpit payload is computed on EVERY Today render (the page is `force-dynamic`). `buildCockpitPayload` over seven days runs one indexed query plus the per-row derivations; if the profile shows it, the cheap fix is to pass `initialCockpit: null` and let the client GET it.
- (c) `LivePrintSlot`'s expansion effect re-derives on every status poll. `deriveExpansion` and `nextOpenState` are pure and cheap, but the `prevRef` update inside an effect means a React 19 double-invoke in development sees one extra transition; the manual override and the first-load rule make that harmless, and the pure tests (now including the correction case, Codex 8 / F-S1) pin the semantics. There is no mounted test because jsdom and React Testing Library are not dependencies and none may be added.
- (e) The status payload's `documentRoads` has been sent since slice B and consumed by nothing; Task 8 renders it as the road outcomes. If its verdict vocabulary drifts from `sources`, the two lines could disagree — they are drawn from different sources by design (in-memory ladder vs persisted roads).
- (f) `EarningsRowChips` now reads context, so it renders differently inside and outside the Hub. It is rendered nowhere else today, but a future reuse would silently lose the stage chips rather than fail.
- (h) NEW, from the fold: the `Live prints outside this week` block names the symbol, the state and the effective window but no DATE, because `GET /api/print-watch/status` carries no event date and F may not edit that route (E owns it). If the block proves hard to place in time, the fix belongs in E's route as an additive `eventDate`, not in a client-side lookup.
