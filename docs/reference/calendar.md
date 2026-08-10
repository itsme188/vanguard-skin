> Archived from CLAUDE.md on 2026-08-10. All facts preserved; read when working in this area.

# Calendar

The calendar subsystem gathers company events (earnings, WSH), macro-economic release dates, and
newsletter-derived context, enriches them with Claude, stores them in `calendar_events` /
`calendar_briefings`, and ships them out as automated emails driven by launchd (Mac) plus a
Cloudflare Worker cloud-fallback path.

---

## 1. Event sources

### 1.1 WSH (Wall Street Horizon)

- WSH provides company events via `reqWshEventData()` on **raw `IBApi`**. IBApiNext has **NO** WSH
  wrapper, so we access `(ibApiNext as any).api`.
- The WSH JSON format is **undocumented** — the `raw_json` column stores the full response for
  debugging/iteration.
- Files:
  - `lib/tws/wsh.ts` — WSH fetch with Promise wrapper.
  - `lib/calendar/parse-wsh.ts` — defensive parser.

### 1.2 Macro events (FRED + hardcoded)

- Macro event dates come from the FRED `releases/dates` API (authoritative).
- FOMC + ISM Mfg/Svc + UMich Sentiment + Conf Board Consumer Confidence dates are **hardcoded**,
  because those publishers are not federal agencies and therefore are not in FRED.
- `lib/calendar/macro-events.ts` — FRED dates + non-FRED hardcoded schedules + Claude verify +
  Claude enrichment.

### 1.3 Finnhub earnings

- `lib/calendar/finnhub.ts` — per-held-stock earnings scan (source `finnhub`). Two-phase:
  `/calendar/earnings` per symbol → surprise history (`/stock/earnings` — the free tier returns an
  empty array; estimates-only is enough).
- Pacing: 550 ms → roughly 35 s for about 60 stocks.
- `FINNHUB_API_KEY` lives in `.env.local`.

### 1.4 Held-symbol resolution

- `lib/queries/briefing-symbols.ts` — `getHeldStockSymbols()` filters to
  `security_type IN ('stock', 'common stock')` across all accounts, latest date per account.

### 1.5 Excluded events

- Dividends / ex-dividends are filtered **OUT** of the calendar (user preference — too noisy).

### 1.6 Claude's role

- Claude Sonnet is used for **enrichment only** (descriptions, consensus estimates, impact ratings).
  It **never** produces dates from scratch.

---

## 2. FRED release ID drift guard

Every entry in `RELEASE_MAP` carries `expectedNameKeywords`. `releaseNameMatches()` skips and warns
if FRED's `release_name` doesn't match.

Verified against FRED `/releases` on **2026-04-18** — do **NOT** edit IDs without re-verifying.
Memory: `feedback_verify_external_truth.md`.

---

## 3. FRED actuals: per-series units + release-day vintage

**2026-06-11, commit `d3e9361`.**

### 3.1 Per-series units

`RELEASE_ID_TO_SERIES` lives in `lib/calendar/enrich-actuals.ts` plus a Worker mirror, parity-pinned
by mirrored tests. It carries a per-series `unitScale`:

- **ICSA / EXHOSL** — RAW counts.
- **PAYEMS / HOUST / HSN1F / JTSJOL** — thousands.
- **BOPGSTB** — $-millions.

Verify the FRED `/series` units endpoint before adding **ANY** series.

### 3.2 Semantic `formatAs`

- `delta_k` — payroll-style change prints.
- `level_count` — level-quoted prints (claims "229K", home sales "4.17M").
- `usd_millions`.

The retired one-size `level_k` stored "+4,000K" for 229K claims.

### 3.3 Release-day vintage

Fetches go through `fetchFredVintageForEvent`: ALFRED `realtime_start`/`realtime_end = event_date`,
so the stored actual is the release-day **FIRST PRINT**. (Observation dates are data-period dates; a
late re-run would otherwise pull later-published months plus revisions.)

There is a prior-month-end `observation_end` fallback for no-vintage series — EXHOSL 400s on
realtime params.

### 3.4 Repair precedent

`scripts/repair-macro-actual-scale.ts` — dry-run by default, `--apply` to write. Scope = EVERY
mapped release since 2026-06-12; recompute-and-compare keeps it idempotent.

Memory: `reference_fred_units_vintage.md`.

### 3.5 ADP

ADP = **MONTHLY `ADPMNUSNERSA`**, never the weekly series.

### 3.6 Second wave (2026-06-12, commit `d7e8fc1`)

`pct_yoy` rows were NOT "always correct":

- The `priorYear` lookup scanned DESC rows for the first 11–13-months-back match, which always
  landed on 11 → wrong YoY base. Sparse test mocks hid it; the regression fixture is a full real
  ALFRED month sequence.
- Release 46 mapped to **PPIACO** (all-commodities, +13.1% May YoY) instead of the press-headline
  **PPIFIS Final Demand** (+6.4%).

Fix: exact-12-first, with the window as a vintage-hole fallback — both sides parity.

**Rule:** when picking a FRED series for a release, match the series the **PRESS** quotes, not the
release's legacy flagship. Verify membership via `/series/release`.

---

## 4. Reschedule verification (non-FRED)

`verifyNonFredReschedules()` calls Claude with `web_search_20250305` against publisher calendars. If
an event is rescheduled it applies the new date and stores `reschedule_verified_at` + `source_url`
in the event's `raw_json`.

On Claude error it falls back to the hardcoded date — it never regresses.

---

## 5. Sync cleanup is enrichment-aware

**2026-06-10, commit `16f3b92`.**

`lib/calendar/sync.ts::syncCalendarForWeek` (the delete moved here from the route when sync was
extracted) calls `deleteUnenrichedEventsForWeek` (`lib/mutations/calendar.ts`) before each source's
upsert (claude_macro / finnhub / nasdaq).

- It deletes **ONLY** rows with all four enrichment columns NULL.
- Un-enriched reschedule orphans still get cleaned (`source_key` includes the date), but enriched
  rows survive.
- Invariant: **sync may only ADD data** — the same invariant as the enrichment-runner COALESCE
  guards.
- The upsert's conflict clause never touches enrichment columns and COALESCEs `release_time`.

**Why:** pre-fix, the unconditional delete wiped captured actuals on every "Refresh from Finnhub"
AND cascaded away `earnings_emails` / `earnings_email_skips` audit rows.

Test: `tests/calendar/sync-preserves-enrichment.test.ts`.

---

## 6. Calendar event suppressions — the wrong-sync-date correction path

**Migration 070, 2026-07-26, commit `9cade35`.**

`calendar_event_suppressions` records `(symbol, event_date, event_type)` tuples the user deleted.

- `upsertCalendarEvents` — the single choke point every sync source (finnhub / nasdaq / wsh /
  claude_macro) flows through — skips matching **non-manual** events. It is table-existence tolerant
  for minimal test DBs.
- Keyed on the **SEMANTIC tuple, NOT `source_key`**: Finnhub AND Nasdaq both scan earnings, so a
  `source_key` suppression would leave the other source free to re-insert the same wrong date.
- `insertCalendarEvent` (manual) deliberately **ignores** suppressions — explicit user action wins.

Deleting a sync row CASCADEs its audit rows away (acceptable — the event was wrong).

Repair CLI: `scripts/correct-earnings-date.ts <SYM> <WRONG> <CORRECT> [bmo|amc]`

- Inserts the corrected manual row **FIRST** so `earnings_bogeys` migrate instead of dying in the
  cascade.
- Refuses when the wrong row has captured actuals (a captured print really happened on that date).

Precedent case: NET Finnhub 2026-07-30 vs. real Aug 6.

Test: `tests/calendar/event-suppressions.test.ts`.

---

## 7. Weekly briefing

- `lib/calendar/briefing.ts` — weekly briefing via **Opus 4.7** (not Sonnet — this is the one email
  read most carefully).
- Reads **FULL** `raw_text` from 4 preferred weekend sources: Vital Knowledge (id=1), Eliant Capital
  (18), Purple Drink's Market Musings (19), Helene Meisler (28). Other sources contribute at
  summary level.
- Surfaces expiring options + Finnhub earnings + macro events.
- 30k chars/article + 200k total cap keeps input cost at roughly **$0.65/run**.
- `lib/queries/research.ts::getFullTextForSources()` — fetches processed articles' `raw_text` for a
  source-id list over a lookback window.
- `lib/vital-knowledge.ts` — IMAP-based Vital Knowledge newsletter fetching (ported from Stock
  Contest).
- Weekly briefings are stored in the `calendar_briefings` table, one per week (UNIQUE on `week_of`).

### 7.1 Email-route caching quirk

`POST /api/calendar/email` does **NOT** regenerate if a briefing row already exists for the week.

If you run `/sync` after a briefing was saved (e.g., new Finnhub events land), you must
`POST /api/calendar/briefing` first to regenerate, then `POST /api/calendar/email`.

Sunday automation isn't affected because sync fires before email.

---

## 8. Newsletter HTML rendering

### 8.1 Sandboxed iframe only

**2026-07-26, commit `69c265b`.**

`app/dashboard/components/NewsletterArticleFrame.tsx` is the **single render primitive** for stored
email HTML.

- `buildNewsletterSrcDoc` composes a standalone document: reader CSS with theme tokens resolved to
  **CONCRETE** values via `snapshotReaderTokens` (an iframe `srcDoc` inherits no CSS custom
  properties), plus `<base target="_blank">`.
- The sandbox is **WITHOUT** `allow-scripts`. `allow-same-origin` is safe on a script-less doc and
  enables the auto-height measure.
- **Never** `dangerouslySetInnerHTML` newsletter HTML: a document-global `<style>` block in one
  email restyled the ENTIRE app (blue anchors, white background) until reload, despite write-time
  sanitization.
- Both prior sites converted: ResearchFeedsView expand + Security Detail
  ResearchMentionsSection.
- Same isolation trade as DigestEmailViewer / EarningsEmailViewer.

### 8.2 Readability pipeline

**2026-05-05.**

`lib/gmail/sanitize.ts` exposes two passes:

1. `sanitizeNewsletterHtml` (**security**) — tag allowlist; scripts/styles/iframes/trackers
   stripped; dangerous URL schemes blocked; `trimEmailFooter` cuts at copyright/unsubscribe markers.
2. `normalizeNewsletterHtml` (**readability**) — strips publication chrome at the head, collapses
   whitespace-only block wrappers, collapses runs of `<hr>` / `<br>`, drops single-link CTA
   paragraphs like "Read more" / "View online", unwraps single-cell layout tables, trims trailing
   structural orphans.

Both are pure regex-only — no DOM library.

**Always chain both** at write time: `normalizeNewsletterHtml(sanitizeNewsletterHtml(html))`.

The `<p>:empty { display: none }` rule in `prose-newsletter` CSS is defense-in-depth for any
whitespace-only paragraph that survives.

Backfill script: `scripts/backfill-newsletter-html.ts` — idempotent, writes only when the result
differs. Ran 2026-05-05 against 543 articles, producing roughly 8% byte reduction overall, with
individual articles seeing 13–73% reduction.

**Critical gotcha:** `trimEmailFooter`'s tail cleanup MUST NOT strip closing tags — they're the
natural end of body content above the footer, and stripping them produces unbalanced HTML that the
normalizer's table-unwrap can't process. The regex was narrowed 2026-05-05 to only strip whitespace
+ standalone `<br>` / `<hr>` + orphan OPENING block tags.

---

## 9. `source_url` extraction is sender-gated

**U5, 2026-06-15.**

`lib/gmail/extract-url.ts::extractSourceUrl(rawHtml, rawText, sender)`.

- The generic in-body `*.substack.com/p/` regex grabbed the FIRST such link anywhere in the HTML,
  mis-attributing a Sharp Text issue (a Ghost site, no matching "view in browser" anchor) to an
  unrelated Soapbox Trade Substack post it linked to in the body.
- The substack-post fallback now only returns when the link's registrable domain matches the
  **sender's** domain (or no sender given — legacy).
- A new plaintext "View in browser ( URL )" fallback recovers the canonical URL.
- Both `fetch.ts` call sites plus the backfill SELECT pass `sender`.
- Repair: `scripts/repair-mismatched-source-urls.ts` (dry-run default).
- The research-feed article card + empty-expand fallback now also surface an "Open original ↗" link
  (`source_url ?? website_url`).

### 9.1 `cleanUrl` strips `?access_token=…` credentials (2026-07-20)

Stratechery / Sharp Text (Passport) view-in-browser links embed the subscriber's personal JWT, which
was stored verbatim and mailed to cc'd digest recipients.

Generic `token` params are deliberately **KEPT** — they are functional single-email view-online keys
and stripping them breaks the link.

Repair for pre-fix rows: `scripts/repair-source-url-tokens.ts` (idempotent, dry-run default; ran
2026-07-20 over 68 rows).

---

## 10. Outbound email rendering

- `lib/email.ts` — Resend SMTP sender:
  `sendEmail({to, subject, html, fromLocalPart, replyTo?})`.
- `lib/calendar/briefing-html.ts` — the single markdown→HTML renderer used by **ALL** outbound
  emails (Sunday briefing, daily digest, earnings preview, earnings recap).
- Light Amber theme matching the app's Research Feeds reader: cream canvas, 18px/1.7 ink-dim,
  system-font stack with Plex first + system fallback so Outlook never breaks.
- Worker mirror at `workers/cron/src/html.ts` for cloud-fallback parity.

### 10.1 Quote-handling gotcha

Font-family names with spaces use **SINGLE** quotes inside the double-quoted style attribute
(`'IBM Plex Sans'`, not `"IBM Plex Sans"`); mixing breaks Safari attribute parsing. Header docs
explain.

### 10.2 Inline-emphasis regexes must NEVER touch a generated href (2026-07-20)

`inlineFormat` swaps each link's URL for a NUL-delimited (`\u0000`) placeholder while the bold /
italic / code passes run, restoring it last.

Real-world hrefs (Stratechery `?access_token=<JWT>`, beehiiv redirect JWTs) contain `_` / `*`, and
pre-fix the `_(.+?)_` pass injected `<em>` **INSIDE** the attribute, so mail clients rejected the
anchor and leaked the raw token as visible text in the 7/20 digest.

- Change **BOTH** renderers together.
- Pinned by `tests/calendar/briefing-html-inline.test.ts` + `workers/cron/test/html.test.ts`.
- Any new inline pass added to `inlineFormat` must run **between** the link-placeholder swap and the
  restore.

---

## 11. Apple Calendar — dormant code

`scripts/read-calendar.swift`, `bin/read-calendar`, and `lib/calendar/apple-calendar.ts` exist but
are **not wired into any route**. They are kept in case IBKR ever exposes per-calendar routing.
`CalendarEventSource` still lists `"apple_calendar"` for the same reason.

---

## 12. Scheduling: all Mac launchd jobs use ET wall-clock, never local time

**2026-05-21.**

macOS launchd has no per-job timezone override — `StartCalendarInterval` always fires at the
system's local clock, which is wrong whenever the Mac travels off-ET. This broke for roughly weeks
while the user was in Israel (8:45 IDT = 1:45 AM ET).

- All time-of-day plists use `StartInterval=300` (every 5 min) + self-gate via
  `scripts/lib/et-gate.sh` — `source` it, then `in_et_window "<dow_set>" <hour> <min> [window=10]`.
- `dow_set` is comma-separated `%u` digits (1=Mon .. 7=Sun).
- The 10-min default window means ≤2 ticks land per window; API marker dedup absorbs duplicates.
- Two scripts use the helper for wider windows (research-sync's 10h business-hours range) by reading
  the cached `$ET_DOW` + `$ET_MIN_OF_DAY` vars directly instead of calling `in_et_window`.
- **Never re-introduce `StartCalendarInterval`** — `plutil -lint` won't catch it, but every email
  will arrive on the wrong continent's schedule.
- The Cloudflare Worker side is already ET-correct via `getCurrentETHour()` in
  `workers/cron/src/dst.ts`.

### 12.1 Mac-first tick offset

**2026-06-09, supersedes the 2026-05-29 minute-gate.**

Every Worker email dispatch sits **ONE `*/15` tick AFTER** the Mac's et-gate window, never ON it:

| Email | Worker | Mac |
|---|---|---|
| Digest | 9:00 | 8:45 |
| Briefing | 16:45 | 16:30 |
| Evening Mon–Thu | 19:15 | 19:00 |
| Evening Fri | 17:45 | 17:30 |

New env: `EXPECTED_MINUTE_EVENING_MON_THU`, code default `"15"`.

**Why:** sharing the tick meant the Worker (cron fires within seconds of the minute) claimed
`cloud-attempting` before the Mac's randomly-placed tick ran, so the awake Mac lost the race EVERY
day. Observed 6/3–6/9: all digests + evenings shipped the thinner cloud composition.

**Never set a Worker dispatch minute equal to the Mac's launchd target.**

`send-weekly-briefing.sh` also fires the briefing at 15:00 ET on **BOTH** Sunday and Monday (for the
holiday-shift); the route + `shouldSendBriefingToday` pick the real send-day.

---

## 13. launchd plists (`~/Library/LaunchAgents/`)

### 13.1 `com.vanguard-skin.weekly-email.plist`

**Sunday 4:30 PM ET** — week-ahead calendar briefing.

Shifted 5 PM → 3 PM on 2026-04-19, then → 4:30 PM on 2026-06-07 so Eliant Capital's late-published
weekly is captured; gate hardened 2026-05-21.

Worker `EXPECTED_HOUR_BRIEFING=16` + `EXPECTED_MINUTE_BRIEFING=30` mirror the Mac et-gate.

### 13.2 `com.vanguard-skin.daily-digest.plist`

Weekdays **8:45 AM ET** — research feed digest.

Uses the **adaptive synthesis layout** as of 2026-05-08: ≥5 articles → Sonnet 4.6 cross-source
synthesis; <5 → per-source.

### 13.3 `com.vanguard-skin.evening-email.plist`

**Mon–Thu 7 PM ET + Fri 5:30 PM ET** (added 2026-05-08) — evening newsletter recap with a 2× beta
Vanguard anomaly block.

- Composer: `lib/digest/send-evening.ts`.
- Cron route: `/api/cron/evening`.
- Mirror plist in repo at `docs/launchd/`.
- See `memory/project_evening_email.md`.

### 13.4 `com.vanguard-skin.nightly-qa.plist`

Daily **2 AM ET** — agent-browser smoke test (see `memory/project_nightly_qa.md`).

**Scenarios rewritten to the 6-tab IA 2026-07-20 (`61946e0`)**:

- 9 navigations targeting redirect **DESTINATIONS** (`accounts?id=all#holdings`,
  `today?view=week-ahead`, analysis `?view=performance` / `?view=diagnostics`).
- Portfolio value reads `GET /api/summary`, not the DOM.
- Text checks use lowercase `innerText` — CSS `text-transform:uppercase` labels read as all-caps at
  runtime, and matching mixed-case shipped false FAILs twice.
- First fully-green run 2026-07-20 (26P / 0F / 0S).
- Scenarios doc: `qa/test-scenarios.md`; expected values in gitignored `qa/expected-values.json`
  (auto-re-baselines on PASS).

### 13.5 `com.vanguard-skin.nightly-deep-qa.plist`

Daily **2:45 AM local** — a deliberate LOCAL-time exception to the ET rule, because it gates on
Mac-idle, not market hours.

**Mechanism (2026-06-11):** `StartInterval=300` + in-script self-gate (once per local day, first
tick in 02:45–07:00; marker `qa/findings/.deep-qa-last-run`; `DEEP_QA_FORCE=1` bypasses).

**Never `StartCalendarInterval`** — launchd evaluates it in the timezone cached at **BOOT**, not the
current one. The Mac booted 5/20 in Israel, so "02:45" fired 19:45 ET nightly and collided with
evening use.

**Sandbox.** Exploratory "synthetic owner" QA sweep: `qa/sandbox.sh` snapshots the DB
(`VACUUM INTO`) and boots the DEPLOYED Electron standalone on **:3097** with an env allowlist that
pins every former-`.env.local` key to empty. (Learned 2026-06-10 when a verification run sent a real
duplicate digest: `env -i` alone does **NOT** strip outbound.) **Since 2026-06-16 the DMG no longer
bundles `.env.local`** (see the Electron env-threading convention), so the standalone has no secrets
to auto-load anyway — but keep the pinning as defense-in-depth, since the sandbox boots the
standalone directly and could otherwise inherit the parent shell's env.

**Sweep.** Headless `/qa-deep-sweep` skill (`.claude/skills/qa-deep-sweep/`) dispatches parallel
agent-browser zone agents (7 zones). Findings dedupe into `qa/findings/ledger.json` + `FINDINGS.md`
(statuses `new|known|fixed|wontfix` — set `wontfix` to silence). Pushover only on NEW findings.
Auto-fix branch `qa-deep-fixes-*` for objective breakage only (never pushed).

**Config.** `qa/deep-qa-config.json` (`mode: all|rotate` — flip to `rotate` for roughly 80% cost
cut). All findings artifacts are gitignored (public repo). `qa/expected-values.json` untracked
2026-06-10 and **scrubbed from all git history 2026-06-16** (`git-filter-repo` + force-push; that
rewrite changed every commit hash before 2026-06-16).

**npm-cache hardening (2026-06-12, `17c8b7e`).** The zone agents' playwright + sqlite MCP servers are
npx-launched — a sudo-poisoned `~/.npm/_cacache` (root-owned shards) made the 6/12 run sweep 0
zones. The script now exports a dedicated `NPM_CONFIG_CACHE=qa/sandbox/npm-cache` and runs a
fail-fast `npx @playwright/mcp --version` preflight before sandbox boot. Never `sudo npm` /
`sudo npx` (memory `feedback_never_sudo_npm.md`).

**Model selection — callability PROBE, not `--fallback-model` (2026-06-24, `b47cec9`, supersedes
`d284c64`).** `pick_model()` probes each rung (`fable → opus → sonnet`) with a throwaway 1-token
`claude -p "ok" --model <m>` call and passes the FIRST that exits 0 as a concrete `--model` to
`/qa-deep-sweep`.

The 2026-06-15 `--model fable --fallback-model "opus,sonnet"` approach **DID NOT WORK**: Fable 5
stays a valid alias under the gov hold but 404s at use ("Claude Fable 5 is currently unavailable" →
exit 1), and `--fallback-model` does **NOT** rescue the *slash-command* invocation (only plain-text
prompts), so the cron failed silently AGAIN 6/19–6/24 (the job fired nightly — marker + sandbox boot
— but `claude` died in about 6s before the sweep loaded; no findings since roughly 6/15). The probe
mirrors the app-side catalog "probe callability" pattern and auto-returns to Fable when its probe
passes.

**Loud-fail.** `notify_failure()` curls Pushover (tokens from `settings.json` — launchd doesn't load
`.env.local`) on every abort path: no-callable-model / `claude` exit ≠ 0 / sandbox-boot /
npx-preflight. The root systemic gap was silence on non-zero exit.

Sibling app-side systems: `memory/reference_model_tier_resolution.md`;
`memory/reference_headless_claude_model_resilience.md`.

**Sweep robustness (2026-07-17, insights-report follow-ups).**

- The skill checkpoints the ledger merge after EVERY zone-agent return, plus a date-keyed
  `.sweep-progress.json` resume (an interruption loses at most the in-flight zone).
- `qa/lib/agent-browser-cleanup.sh::ab_reap_orphans` reaps `playwright-mcp` / `ms-playwright`
  processes with **PPID 1** at preflight — parentage means orphan certainty; age-based reaping would
  kill live evening-session browsers.
- The global playwright MCP server runs `--isolated` (in-memory profiles) — the 28-min sweep stall
  was Chromium's one-browser-per-profile-dir lock held by an orphan.
- **Zone parallelism is structurally blocked** — subagents share the parent session's MCP server
  processes (researched 2026-07-17; see the skill's Step-1 comment for what a future parallel design
  requires).
- Known cosmetic issue: `sandbox.sh down` `rm -rf` races a lingering npx process →
  `rm: Directory not empty` noise (harmless).

**Auto-fix chain (2026-07-26, shipped DISARMED).** After a verified-complete sweep, the wrapper
invokes headless `/qa-fix-findings` (own model probe + own completeness guard on
`qa/findings/fix-runs/<date>.md`):

1. Classify open ledger findings (`auto` / `needs-decision` / `needs-repro`).
2. TDD-fix in the persistent sibling worktree `../vanguard-skin-qa-fix` (cap 4/night, secret-less
   dev server on **:3096**).
3. LOW / prescribed + `auto_fixable` fixes cherry-pick to LOCAL main (never pushes origin — the user
   pushes at session-end).
4. Sanitized PR from `origin/main` for the rest.
5. TODO-reconcile-then-rebuild.
6. Pushover summary.

Gate: `qa/deep-qa-config.json` → `fixer.enabled` (false until the ARM checklist in TODO.md clears).
Spec: `docs/superpowers/specs/2026-07-26-qa-auto-fix-pipeline-design.md`.

**Hook-interaction rule learned live.** `.claude/hooks/check-todo-reconciled.sh` substring-matches
raw Bash command text for rebuild keywords — never embed those literals in ledger/JSON strings
written via heredoc (write "Electron rebuild" instead). A hook denial is maintainer feedback:
satisfy its precondition or record-and-skip, never restructure a command to evade detection.

### 13.6 `com.vanguard-skin.state-snapshot.plist`

Daily **2 AM ET** — R2 state snapshot for the Worker cloud-fallback path.

### 13.7 `com.vanguard-skin.research-sync.plist`

Every 90 min (`StartInterval=5400`), self-gates to **Mon–Fri 09:00–19:00 ET**.

- Wraps `scripts/run-research-sync.sh` → `POST /api/cron/research-sync`.
- Calls `fetchNewArticles` + `processUnprocessedArticles` + `extractLevelsFromNewArticles` only —
  it does **NOT** send any email.
- The window ceiling at 19:00 leaves room for a planned evening 7pm digest cron to run its own
  pre-send sync without contention.
- Companion in-app hook `lib/hooks/useResearchSync.ts` fires on Research-tab mount and on
  app-refocus after 10+ min idle (debounced to once-per-5-min via `vgs:lastResearchSync`
  localStorage).
- Together: launchd keeps articles fresh during market hours even when the app is closed; the hook
  keeps iPhone-via-mesh fresh whenever the user opens the app.
- AI cost is dominated by article count (each new article = one Claude Sonnet pass), not call
  frequency, so adding the background tier increases Anthropic spend by only about $0.10–0.20/month
  versus the prior 6-runs-per-week cadence.

## Calendar conventions (from the Conventions section)

## Calendar date utilities — single source

`lib/calendar/date-utils.ts` is the single source for the Monday calculation (`getCurrentMonday()`),
`addDays()`, `formatWeekRange()`, and `validateWeekOf()`.

**Never create local date functions.**

## Calendar sync — single source

`lib/calendar/sync.ts::syncCalendarForWeek` is the only place the three-phase ingest
(WSH → Claude macro → Finnhub) lives; both the SSE route and `send-briefing.ts` call it.

New "sync before X" callers **import the function**, never duplicate the route.

## Calendar enrichment window is source-aware

`lib/calendar/enrichment-runner.ts` keeps `MAX_AGE_MS_MACRO = 2h` but uses
`MAX_AGE_MS_EARNINGS = 12h` for `source='finnhub'` OR `event_type='earnings'`.

Rationale: a BMO call at 08:00 can't produce a reaction snapshot before 09:30 — the 2h window
expired the row forever.

Test: `tests/calendar/enrichment-runner.test.ts`.

> See also `architecture-detail.md` for the Calendar Living Record architecture (migration 041 schema, release-time cascade, reaction snapshots).
