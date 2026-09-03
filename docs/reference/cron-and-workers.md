> Archived from CLAUDE.md on 2026-08-10. All facts preserved; read when working in this area.

# Cron, Scheduled Jobs, and the Cloudflare Worker

Covers `workers/cron/` (the Cloudflare Worker), its cron trigger and job dispatch, the
Mac↔cloud marker protocol, every cloud-fallback tier, the R2 state snapshot, and the
Mac-side launchd/pmset schedules. App-side subsystem detail lives in
`docs/reference/architecture-detail.md`.

---

## 1. Workers Cron hybrid — the single trigger (Phase 4 + 2026-05-08 consolidation)

`workers/cron/` is a Cloudflare Worker that runs a **single `*/15 * * * *` cron trigger**,
consolidated from 9 timed triggers on 2026-05-08 because the **Cloudflare Workers Free plan
caps at 5 cron triggers per Worker**.

`scheduled()` runs every 15 min and dispatches via `parseJobFromClock`, which reads ET
wall-clock through `Intl.DateTimeFormat("America/New_York")`:

| ET clock | Job |
|---|---|
| Sun 16:30 | briefing |
| Mon–Fri 8:45 | digest |
| Mon–Thu 19:00 | evening email |
| Fri 17:30 | evening email |
| every tick | calendar-enrich + earnings-fallback (each self-gates internally) |

`runFallbackEvening` mirrors `runFallbackDigest`. `JobType` = `"briefing" | "digest" | "evening"`.

## 2. Fallback-only path and KV markers (Worker→Mac primary retired 2026-08-14, #35 Phase D Task 25)

The Worker→Mac primary call (`MESH_HOSTNAME` → `/api/cron/{briefing,digest}`) is **retired**,
not merely failing: `runJob`/`runCalendarEnrich` go straight from the marker-dedup check to
the cloud fallback, with no ingress attempt at all (`workers/cron/src/index.ts`,
`workers/cron/src/calendar-enrich.ts`). This follows the packaged-app trust-boundary cutover
(`docs/superpowers/specs/2026-08-14-packaged-app-trust-boundary-design.md` §H2) — the Mac now
binds loopback-only behind an Access-gated tunnel, so `MESH_HOSTNAME` is permanently
unreachable from Cloudflare's edge and there is no longer an ingress path worth attempting.
`mac-sent-*` markers are still written by the Mac's own launchd/cron routes on success (see
below) — only the Worker-initiated POST to the Mac is gone.

- **Fallback path (now the only path):** `src/fallback-{briefing,digest}.ts` generates the email from the
  latest R2 snapshot + a live Gmail REST fetch (still Gmail OAuth, for inbound newsletter
  listing) + Claude via AI Gateway, sends via Resend REST (`workers/cron/src/resend.ts`), and
  writes a `cloud-sent-*` marker.
- Launchd wrappers (`scripts/send-{daily-digest,weekly-briefing}.sh`) also hit `/api/cron/*`
  with the secret, so Mac-local triggers share the same dedup.
- **Mac pre-flight:** `lib/cron/marker-check.ts::checkCloudMarker` pre-flights the Worker's
  `/internal/marker` endpoint before regenerating; returns null gracefully when
  `WORKER_MARKER_URL` is unset.

**Known fallback gaps (accepted):** TWS-dependent sections (expiring options, live price-level
triggers) are absent in cloud briefings — a footer note discloses this. IMAP-only sources like
Vital Knowledge rely on snapshot deep-read entries rather than live IMAP.

## 3. Mac-first send race — running markers

**Race-fix (2026-04-27):** Mac POSTs to the Worker's `/internal/running-marker?type=&action=set|clear`
at the entry/exit of `/api/cron/{briefing,digest}` via `lib/cron/running-marker.ts` (swallows
errors; KV TTL auto-expires if the Mac dies).

**Superseded 2026-08-09 by `withRunningMarker`:** the initial set is now AWAITED and the marker
**HEARTBEATS every 2 min** for the lifetime of the send, with `RUNNING_TTL_SECONDS` raised
10 → 15 min. Both halves were load-bearing and either alone lost the race:

1. `void setRunningMarker()` never completed — synchronous better-sqlite3 work starves the event
   loop past the call's own 3s abort (215.6s of auto-refresh on the 8/09 briefing; the awaited
   `checkCloudMarker` one line earlier succeeded on the same tick, which is how we know the
   network was never at fault).
2. The 10-min TTL was shorter than the gap from every Mac tick to the Worker dispatch —
   digest 8:45 → expiry 8:55 vs Worker 9:00; evening 19:00 → 19:10 vs 19:15;
   briefing 16:30 → 16:40 vs 16:45 — so digest and evening were **never** covered and the
   briefing only when its launchd tick slipped past 16:35. Fast pipelines masked both by
   winning on `mac-sent` instead.

Rules that fall out of this:

- **Never re-introduce a fire-and-forget marker write on a path that then blocks the loop.**
- **Never size this TTL to "how long the pipeline takes"** — that framing is what decayed as the
  pipeline grew 5 → 13–17 min; the heartbeat is what makes pipeline length irrelevant.
- `confirmMacSent` is now awaited INSIDE the wrapper so `mac-sent` lands before `mac-running` is
  released and the handoff has no gap.
- Scope is briefing/digest/evening; **earnings recaps stay deliberately un-gated**.
- Spec: `docs/superpowers/specs/2026-08-09-mac-first-send-race-design.md`.

**Worker re-check before firing fallback** — it re-reads markers right before firing and skips when
(a) `mac-sent-*` is now present (slow but successful primary), (b) `cloud-sent-*` is now present
(race already lost), or (c) `mac-running-*` is set. This closed the 8:45→8:57 thinned-duplicate
window observed 4/27: the primary timed out at 120s while the Mac was still mid-pipeline at 130s,
and the Worker fallback fired without re-checking. `PRIMARY_TIMEOUT_MS` was simultaneously bumped
120s → 300s.

## 4. 2026-05-14 hardening (`ffce179`)

Four sub-fixes after 5/13 lost both digest + evening (no markers, no log trail):

1. `[observability]` enabled in `wrangler.toml` (7d log retention).
2. `scheduled()` reordered so `runJob` is **awaited first**, before earnings-fallback /
   newsletter-fetch / level-scan / calendar-enrich are dispatched via `ctx.waitUntil` —
   co-scheduled siblings were competing for the single invocation's wall-clock + subrequest
   budget and the email job's marker write was the casualty.
3. New `cloud-attempting-{type}-{date}` KV marker (10-min TTL, `dedup.ts::setAttemptingMarker` /
   `clearAttemptingMarker`) — the Worker writes it BEFORE the heavy Gmail+Claude+Resend work and
   clears it after success or error. The next 15-min tick reading markers sees it and skips, so
   concurrent ticks can't double-send. `getMarkerStatus` returns `sentBy=cloud` when the
   attempting marker is set, so Mac's `checkCloudMarker` also skips while a fallback is in-flight.
4. `runCatchUp()` sweep at the end of every `scheduled()` re-tries any digest/evening/briefing that
   should have shipped by now but lacks a marker, inside bounded post-dispatch ET windows —
   digest 9:00–12:00 ET Mon–Fri, evening 20:00–23:00 ET Mon–Thu / 18:00–22:00 ET Fri,
   briefing 17:00–22:00 ET Sun — bounded so a missed morning digest never ships at 4pm.

**Mac side:** `confirmMacSent(type)` in `lib/cron/running-marker.ts` is called from all three
`/api/cron/{briefing,digest,evening}` routes after a successful send, via the Worker endpoint
`POST /internal/mac-sent?type=&date=` (X-Cron-Secret gated). Without it the catch-up sweep would
fire a duplicate every weekday the Mac is awake-and-launchd-succeeds, because `mac-sent` is
otherwise only written when the Worker's primary call to the Mac succeeds — which was rare even
before the primary call existed as a possibility at all: at the time of this 2026-05-14 fix,
`MESH_HOSTNAME` `http://100.96.0.1:3099` (Mesh CGNAT) wasn't reachable from Cloudflare's edge and
fast-failed with CF 1016. **Update (2026-08-14, #35 Phase D Task 25):** the Worker→Mac primary
call is now retired outright (§2 above) — `mac-sent-*` is written exclusively by the Mac's own
routes going forward, never by a Worker-initiated call.

## 5. Pushover deep-link fix (`4e9bd88`)

`PUSHOVER_LINK_BASE` env var threaded through the standard 4 Electron touchpoints (AppSettings
interface, `bootstrapFromEnvLocal`, `getSanitizedSettings`, `electron/main.ts` env plumbing); set
to `http://100.96.0.1:3099` in `.env.local` + `settings.json` + Worker secret. Replaces the broken
`http://localhost:3099` default that produced "Safari can't connect" when notifications were tapped
from the phone.

**Pending (2026-08-14, #35 Phase D, spec §H2):** the mesh IP is retired (loopback-only cutover,
§2 above). `PUSHOVER_LINK_BASE` still needs to be repointed from `http://100.96.0.1:3099` to
`https://app.myportfoliodesk.com` in `.env.local` + `settings.json` + the Worker's own secret —
in lockstep, or the phone gets a dead link from one side. This is an ops step tied to the tunnel/
Access cutover, not shipped by Task 26 (code + docs only).

## 6. 2026-05-20 cloud digest unsilencing (`f9af693`)

Three cascading bugs hid a 6-day silent outage starting 5/14, each only surfacing once the prior
was lifted:

- **(a) Anthropic credits exhausted** — every `processArticle` returned 402, a blanket `try/catch`
  swallowed every error, `newProcessed.length === 0`, `composeDigestMarkdown` returned null, and
  `runFallbackDigest` returned `kind:"no_articles"` — indistinguishable from a quiet news day in
  marker state. Topping up credits unblocked it but didn't fix the masking.
- **(b) Workers free-tier 50-subrequest cap** — old constants (15 articles × 5 messages ×
  28 sources) blew past it. New: `MAX_ARTICLES_PER_RUN=10`, `MAX_MESSAGES_PER_SOURCE=1` (a named
  constant — was hardcoded 5). 28 list + 10×2 = 48 subrequests, leaving headroom for recipient
  resolution + Resend. *(2026-09-03, Ruling R25: the armed-events KV read took that arithmetic to
  50, so `MAX_ARTICLES_PER_RUN` is now 9 — 28 list + 9×2 + 1 spark + 1 KV = 48, Resend spends the
  49th. The KV read itself is skipped below snapshot v11. Recount this line before adding any
  subrequest.)*
- **(c) Resend REST rejects comma-joined `to`** — `BRIEFING_EMAIL_TO="a@x.com, b@y.com"` is
  multi-recipient by default; Mac's nodemailer handles it natively but
  `workers/cron/src/resend.ts` was wrapping `to: [opts.to]` without splitting → 422
  "Invalid `to` field". Fix: `opts.to.split(",").map(trim).filter(Boolean)` before wrapping. All
  three Worker fallbacks (digest + briefing + evening) funnel through this one `sendEmail`, so the
  fix covers all three.

**Observability pattern (apply to sibling fallbacks):** every upstream call wrapped in
`try { … } catch { console.warn(…) }` must track `listErrors` / `articleErrors` / `lastError`
counters and bubble them up as `kind:"error"` when ALL attempts fail. The OLD silent-swallow path
is what hid the credit exhaustion for 6 days — `console.warn` doesn't reach the user.

**Diagnostic ladder for the next silent failure:**

0. **STORED Worker logs first** — `CLOUDFLARE_OBSERVABILITY_TOKEN` in `.env.local` (added
   2026-07-15) queries `POST /accounts/{id}/workers/observability/telemetry/query` for the 7-day
   log history; on 7/15 this disproved a convincing status-page theory in one query (the real cause
   was a code bug — see the jsonSchema convention).
1. Anthropic billing
2. AI Gateway dashboard
3. `wrangler tail` + `/internal/trigger?dryRun=true`
4. KV marker scan
5. R2 snapshot age
6. subrequest cap
7. Resend recipient format

See `memory/feedback_cloud_silent_failure_checklist.md` (has the exact query shape + provider
status JSON APIs).

## 7. Env vars

- **Mac needs:** `CRON_SHARED_SECRET` + optional `WORKER_MARKER_URL`.
- **Worker needs:** `CRON_SHARED_SECRET` + `MESH_HOSTNAME` (no longer used for Mac ingress —
  §2 — but still read as the Pushover deep-link base fallback until the cutover repoints
  `PUSHOVER_LINK_BASE` to `app.myportfoliodesk.com`, §5) + `ANTHROPIC_API_KEY` +
  `CLOUDFLARE_ACCOUNT_ID`/`GATEWAY_ID` + `BRIEFING_EMAIL_TO` + `RESEND_API_KEY` +
  `RESEND_FROM_DOMAIN` + `WORKER_GMAIL_CLIENT_ID`/`SECRET`/`REFRESH_TOKEN` (kept for inbound
  newsletter listing, not outbound).
- The Worker reuses R2 bucket `vanguard-skin-statements`.
- `CLOUD_ENRICH_ENABLED=true` gates the Phase 9b calendar cloud-fallback (§10).

## 8. R2 state snapshot

Written nightly at 2am by `scripts/snapshot-state-to-r2.ts` (launchd
`com.vanguard-skin.state-snapshot.plist`).

**Staleness self-heal (since 2026-07-15):** `run-snapshot.sh` runs on the next 5-min tick
regardless of hour if the last SUCCESSFUL snapshot is >26h old (Mac slept through 02:00 — the 7/15
cloud digest had been composing on a 7/13 snapshot). Tracked via the gitignored
`data/.state-snapshot-last-success` marker, touched only after a clean run.

**Schema versions** (each additive; older snapshots degrade gracefully):

| Version | Adds / used by |
|---|---|
| v2 | holdings / securities / accounts / earnings_emails / earnings_settings rows — read by `fallback-earnings.ts` |
| v3 | `vanguardHoldings`, `securityBetas`, expanded `settings` (last_digest_sent_at + per-email recipients + synthesis_fallbacks_last_30d). Worker fallback at v3 reads cached betas + Yahoo last-2-closes for the evening anomaly block; v2 snapshots gracefully degrade (no anomaly) |
| v4 | `securityLevels` — read by `level-scan.ts` |
| v5 (2026-06-02) | notes + earnings bogeys mirrored to the earnings cloud fallback |
| v6 | `modelCatalog` — Worker reads the AI model catalog from here |
| v8 (2026-07-05) | `watchlistSymbols` (additive; older snapshots degrade Worker pushes to held-only) |
| v11 (2026-09-03) | `armedEvents` + `armedGeneration` (the KV-delta watermark) and `eps_consensus_vendor` on `earningsBogeys` rows — read by `armed-events.ts::effectiveCalendarEvents`. Snapshots ≤ v10 ignore the delta and degrade to held + watchlist (see §15) |

## 9. Mac-side scheduling (launchd + pmset)

- `com.vanguard-skin.calendar-enrich.plist` — `StartInterval=900`, runs `scripts/enrich-calendar-events.sh`
  every 15 min. Runs **24/7 — there is NO ET gate**, and evening ticks are load-bearing: AMC recaps
  + the migration-062 enrichment retries depend on them. **Never add a market-hours gate.** A stale
  "09:30–18:00" comment claiming otherwise was corrected 2026-07-05. The shell script calls
  `POST /api/cron/earnings-sweep` after the existing enrichment call.
- `com.vanguard-skin.state-snapshot.plist` — nightly 2am R2 snapshot (§8).
- `scripts/send-daily-digest.sh` / `scripts/send-weekly-briefing.sh` — launchd wrappers that also
  hit `/api/cron/*` with the shared secret for dedup.
- **Outside the repo:** `pmset repeat wakeorpoweron MTWRF 08:40:00` (registered 2026-07-15) wakes
  the Mac for the 8:45 digest window.

## 10. Cloud calendar enrichment (Phase 9b, 2026-04-25, flag-gated)

The launchd enrichment loop is mirrored by Workers cron `*/15 * * * *` via
`workers/cron/src/calendar-enrich.ts::shouldRunCalendarEnrich`.

When the Mac primary fails and `CLOUD_ENRICH_ENABLED=true`, the Worker reads the R2 state snapshot
(extended to a `daysAgo(1)` trailing window), filters in-window candidates, fetches the actual from
FRED + Finnhub (Claude nonfred deferred to the Mac), and reaction bars from **Yahoo Finance**
(`query1.finance.yahoo.com/v8/finance/chart/{sym}?interval=1m&period1&period2` — free, no auth,
real-time, ~10-day 1-min retention). It writes `cloud-enriched-{eventId}` KV payloads (7d TTL).

**B8 (2026-07-07):** earnings-row payloads are retry-until-complete (the Worker mirror of migration
062 — macro stays single-shot exact), gated to a T+115min reaction-ready window; the self-gate runs
09:30–18:59 ET (extended from 18:00 so late-AMC prints get capturable ticks); and the Worker's
earnings recap fallback reads these completed payloads directly as a same-day recap road
(actual-required + plausibility-gated, no live Mac wake needed).

**Mac reconciliation:** on every wake via `/api/calendar/reconcile-cloud-enrich`, piggy-backed on
`POST /api/calendar/enrich`, reading payloads from the Worker's `GET /internal/cloud-enriched` with
**TWS-always-wins** precedence (`json_extract(reaction_snapshot, '$.source') = 'tws'` skips the
reaction overwrite; still upserts actual). After the DB commit, the Mac DELETEs the KV key.
`POST /api/calendar/enrich { upgradeReactionToTws: true }` body flag re-captures TWS bars over a
cloud-sourced row via `runTwsReactionUpgrade`.

**Why Yahoo over Polygon:** Polygon Starter has a 15-min delay, which would tick events out of the
2h candidate window before bars become available; Polygon Advanced ($199/mo) is overpriced;
Finnhub `/stock/candle` has been paid-only since 2024. Yahoo risk: unofficial endpoint, graceful
null fallback on breakage.

## 11. Earnings cloud fallback (Phase 4)

`workers/cron/src/fallback-earnings.ts` produces a lean compact email (scoreboard + cross-account
positions + actuals + reaction) when the Mac is unreachable. Analyst / transcript / sell-side
context is intentionally NOT mirrored, to avoid Mac-prompt divergence — **but notes + earnings
bogeys ARE mirrored as of snapshot v5, 2026-06-02; see the cloud-fallback travel-hardening entry
below**. It reads the R2 snapshot at schemaVersion 2 (the snapshot script was bumped to add
holdings / securities / accounts / earnings_emails / earnings_settings rows).

**Marker plumbing:** `workers/cron/src/earnings-markers.ts` + `lib/cron/earnings-marker-check.ts`,
keyed on (phase, eventId): `mac-sent-earnings-*`, `cloud-sent-earnings-*`,
`mac-running-earnings-*`. Mac cron routes pre-check `cloud-sent-*` → skip if the Worker fallback
already fired; set running on entry, write mac-sent on success, clear running in `finally`. Three
Worker endpoints `/internal/earnings-{marker,running-marker,sent-marker}`, all X-Cron-Secret-gated.

**Gate:** `shouldRunEarningsFallback` is wider than calendar-enrich — Mon–Fri 05:00–20:00 ET — to
cover BMO previews + AMC recaps. Plan: `~/.claude/plans/okay-let-s-see-if-joyful-feather.md`.

**Pre-season hardening (2026-07-05):** the Worker preview window is [105,120] vs Mac's [105,135]
(Mac-first).

**Wave 1 cloud-side items (2026-07-05 evening, `f3cc804..8eace90`):**

- **push-at-print** — Pushover on the null→non-null `actual_value` transition from Mac enrichment,
  Mac reconcile, AND Worker cloud-enrich — deduped on the shared KV key `print-push-{eventId}`
  (7d TTL), with stale-`fetchedAt` payloads suppressed. Composer `lib/alerts/print-push-message.ts`
  is PURE / zero-import with a byte-parity Worker mirror + parity test.
- **B7** — shorts render presence-only in earnings emails (never-netted long/short buckets;
  `formatCombinedExposurePresence` in the Worker `presence-position.ts` mirror).
- Snapshot **v8** adds `watchlistSymbols` (see §8).

## 12. Tier 4a — cloud level scan + Pushover (2026-05-11)

`workers/cron/src/pushover.ts` is the Worker analogue of the Mac push module.
`workers/cron/src/level-scan.ts::runLevelScan` reads `securityLevels` from the R2 v4 snapshot
(**static-only** — MA-based levels stay Mac-only), fetches the latest 1-min price from Yahoo per
symbol, fires Pushover directly, and writes a `cloud-fired-level-{id}` KV marker (24h TTL) on each
new cross.

Gates Mon–Fri 09:30–16:00 ET via `shouldRunLevelScan()`; pre-checks the `mac-recent-scan` KV marker
(90 min TTL) to skip scans while the Mac is alive.

**Mac side:** `lib/alerts/reconcile-cloud-fired.ts::reconcileCloudFiredLevels` polls the Worker's
`GET /internal/cloud-fired-levels`, inserts `level_alerts` rows + flips `security_levels.is_active=0`
to match Mac-side post-fire state, and DELETEs each KV key after reconcile. Wired as the **first
step of auto-refresh Step 6**, before `detectAndFireAlerts` runs, so the inbox catches up before
Mac's own scan would re-fire. `postMacRecentScanMarker` posts to the Worker's
`POST /internal/mac-recent-scan` after detect completes (fire-and-forget).
`POST /api/levels/reconcile-cloud-fired` is the cron-auth-gated route. Closes the
"Mac asleep → no Pushover" travel-resilience gap.

## 13. Tier 4b — newsletter cloud fallback (2026-05-11)

Sibling pattern to Tier 4a's level-scan + Pushover fan-out, but for newsletter ingestion. When the
Mac is asleep, `workers/cron/src/newsletter-fetch.ts::runNewsletterFetch` fetches Gmail per active
source (reusing the `WORKER_GMAIL_*` OAuth refresh-token + existing `fallback-digest.ts`
infrastructure), Claude-analyzes via the `fallbackNewsletterProcessing` feature key on AI Gateway,
and writes `cloud-fetched-newsletter-<gmail_message_id>` to KV (72h TTL) with the full body, html,
AI fields, and the raw `is_portfolio_relevant` vote.

**Gates:** `shouldRunNewsletterFetch` is top-of-hour only within ET 06:00–20:59; the
`mac-recent-newsletter-sync` KV marker (60 min TTL) skips when the Mac is alive (the Mac POSTs
after each successful `fetchNewArticles`); per-message dedup runs against the snapshot's
`recentArticlesMeta` AND existing `cloud-fetched-newsletter-*` KV entries (no re-Claude across
consecutive Worker ticks). **Caps:** 10 articles total / 3 per source per hourly run. DI-shaped
(matches `level-scan.ts`) — tests inject snapshot/Gmail/Claude stubs.

**Mac side:** `lib/research/reconcile-cloud-fetched.ts::reconcileCloudFetchedNewsletters` polls the
Worker's `GET /internal/cloud-fetched-newsletters`, does INSERT OR IGNORE on the
`gmail_message_id` UNIQUE constraint (silently dedups Mac's own fetch that happened to land the
same message during the asleep-wake gap), applies the D3 relevance gate using local
`research_sources.allow_off_topic` (the Worker can't see this column — the Mac is
single-source-of-truth), links mentioned_symbols → securities, and DELETEs each KV key after
success. Wired as Phase 0 of `/api/research/sync` (UI SSE) AND as the first DB step of
`/api/cron/research-sync` (launchd path). `postMacRecentNewsletterSyncMarker` fires
fire-and-forget after each Mac fetch. `POST /api/research/reconcile-cloud-fetched` is
cron-auth-gated.

**Why the D3 gate at the Mac, not the Worker:** it keeps `allow_off_topic` single-source —
mirroring it to the R2 snapshot would work but is premature optimization (the column is rarely set
and the reconcile cost is trivial). The Worker's newsletter path uses the same extraction schema
but stores the **raw** `is_portfolio_relevant` vote; the Mac applies the gate at reconcile time so
the per-source opt-out still influences the outcome.

## 14. Worker mirrors — files that must change in tandem

These Mac-side modules have Worker counterparts that are parity-pinned. Change BOTH sides:

- `lib/calendar/enrich-actuals.ts` ⇄ `workers/cron/src/enrich-actuals.ts` — the Worker mirror
  carries the same `source_key` dispatch regexes.
- `lib/calendar/reaction-snapshot.ts`'s shared pure bar-matching helpers (`matchBarsToReaction`,
  `findNearestBar`, `lastBarAtOrBefore`) are reused by the Worker cloud path.
- `lib/gmail/prompt-caps.ts` ⇄ `workers/cron/src/newsletter-fetch.ts::truncateBodyForPrompt` —
  parity-pinned truncation caps.
- `lib/ai/model-tiers.ts` ⇄ `workers/cron/src/model-tiers.ts` — **byte-parity**, parity-tested. A
  brand-new model FAMILY NAME requires editing both. The Worker reads the model catalog from R2
  snapshot v6 (`modelCatalog`).
- `lib/alerts/print-push-message.ts` ⇄ its Worker mirror — byte-parity, parity test.
- `presence-position.ts` (Worker) holds `formatCombinedExposurePresence` for B7 short presence.
- `lib/earnings/armed-events-projection.ts::ARMED_EVENT_PROJECTION_KEYS` ⇄
  `workers/cron/src/armed-events.ts::ARMED_EVENT_ENTRY_KEYS` — parity-tested key SET. The Worker's
  `parseEntry` DROPS unlisted keys by design, so a field added on the Mac alone would be silently
  discarded in the cloud with both suites green.
- `lib/digest/todays-reporters.ts` ⇄ `workers/cron/src/todays-reporters.ts` — the status chip,
  including the `armed` label (see §15).

## 15. Armed-events cloud parity (live print v2 slice A, 2026-09-03)

Spec `docs/superpowers/specs/2026-09-02-live-print-v2-design.md` §4.1 "Cloud"; rulings in
`docs/DECISIONS.md` (2026-09-03). Mac-side detail: `docs/reference/earnings-pipeline.md`
§"Armed coverage + prepare steps".

**The gap this closes.** Cloud coverage used to mean held-or-watchlist, computed from a snapshot
frozen at 02:00. A worksheet armed at 09:00 for a name the desk does not own was invisible to
every Worker fallback, so a Mac asleep before the print produced nothing.

**Snapshot v11.** `scripts/snapshot-state-to-r2.ts` reads everything in ONE transaction and adds:

- `armedEvents` — the full armed list at snapshot time, each entry the minimal projection
  (`eventId`, `symbol`, `eventDate`, `eventTime`, `releaseTime`, `sourceKey`, `source`,
  `consensusValue`, `expectedImpact`, `securityId`, `epsConsensusVendor`, plus `removed` /
  `removedAt` on a tombstone);
- `armedGeneration` — the Mac's `cloud_outbox` `MAX(generation)` observed inside that same read, a
  **watermark**, not a count. Reading both in one transaction is what stops the pair describing two
  different instants;
- `eps_consensus_vendor` on each `earningsBogeys` row (deviation D1 — the vendor EPS never enters
  `eps_consensus`; every surface labels it "vendor, basis unspecified").

**KV key + endpoints.** The delta lives under KV key `armed-events` = `{ generation, entries }`.
Deviation D2: **the Mac never writes KV.** Its outbox drain POSTs the full payload to the Worker,
exactly like every other Mac↔Worker marker:

- `POST /internal/armed-events` — body is the outbox payload. Auth is the shared `/internal/*`
  gate: a missing or mismatched `X-Cron-Secret` is **401** before any handler runs. The handler
  does the read-compare-write and applies **only when `generation` is strictly greater** than the
  stored one, so a replayed or out-of-order POST returns `{ applied: false, generation: <stored> }`
  rather than regressing the key. A body over the size cap is 413; a malformed body is 400; entries
  are parsed through a strict allowlist that DROPS unknown keys, so the Worker can never persist
  (or render) prose the data-flow contract excludes.
- `GET /internal/armed-events` — read-only twin, same auth, no side effects. Returns the stored
  generation and entries (0 / `[]` when absent or corrupt). It exists for the sandbox end-to-end
  and the post-deploy check.

**Resolver.** `workers/cron/src/armed-events.ts::effectiveCalendarEvents(snapshot, delta)` is the
single collection every Worker earnings consumer reads — never the raw snapshot:

1. start from `snapshot.calendarEvents`, **in their original order** (with no additions the
   consumers see byte-identical input to before, so the merge can never reorder an existing run);
2. apply `snapshot.armedEvents`, then the KV delta **only when `delta.generation >
   snapshot.armedGeneration`** — strictly greater, so a snapshot written AFTER a delta can never be
   dragged backwards by that delta's stale copy;
3. a **tombstone is never armed** — it is a statement that the event is NOT armed. It drops the
   event from the armed set and, when the row came only from the projection, from the collection;
   a real snapshot row stays (the calendar still knows about the print);
4. an entry that matches an existing snapshot row overwrites **only the fields the projection
   owns** (date, time, release time, symbol, security id, expected impact, source, source key,
   consensus value). Snapshot-only columns are left alone on purpose: blanking `consensus_estimate`
   or `title` would kill the consensus fallback, empty the reporters table and lose the slot
   inference, and the enrichment/recap gates read `enriched_at` / `actual_value` /
   `reaction_snapshot`. An event with NO snapshot row at all is synthesised whole — safe precisely
   because there is nothing to overwrite;
5. **degraded-v10**: a snapshot below v11 (or a v11 one with no watermark) ignores the delta and
   returns exactly today's behaviour — snapshot rows only, nothing armed. Cloud coverage falls back
   to held + watchlist.

The Mac remains the source of truth; the Worker's read-compare-write is defence in depth, not a
second authority. **The push gates are untouched on both sides** — armed does not open a push.
Date windowing stays each consumer's own job.

**Live horizon: 14 days (R23).** The Mac projection publishes live entries only for armed events
dated `>= today − 14`. An event that ages past the horizon simply drops out of the list — it is
NOT tombstoned, because it is still armed (a tombstone says "no longer armed", and would then be
re-carried for 48 hours for nothing). The sweep-tick reconcile writes the first post-horizon
generation naturally, since the entries differ. Nothing in the cloud selects an event that old, so
the only effect is that the payload stops growing as never-disarmed worksheets accumulate.

**Mac↔Worker coverage asymmetry — accepted.** The Mac's armed leg is CLUSTER-aware (R11: an event
is covered when it, or any unsuperseded same-symbol/same-date earnings row, carries a worksheet
flag), while the cloud's is per-id — `isCoveredInCloud` tests `eff.armedEventIds.has(event.id)`.
Where a vendor twin pair exists and the Mac armed one twin, the Worker covers that twin only. This
is deliberate: the projection ships event ids, the cloud has no cheap way to re-derive the cluster,
and the held/watchlist leg still covers both twins for any name the desk owns.

**A refused POST now surfaces on the Mac.** `applied:false` is the normal reply to a replayed
generation, so it stays a success — EXCEPT when the generation the Worker names is strictly greater
than the one just posted. That is the restored-DB wedge below, and the drain writes
`cloud_outbox.send_error` = `"<host>: worker holds generation <X> > local <Y> — KV key armed-events
needs a reset"` and stops, instead of looping silently forever. Every `send_error` is host-prefixed
(host and port only, never the secret) so the row names the target it could not reach.

**Parity tests.** The projection key SET is pinned across the two sides
(`ARMED_EVENT_PROJECTION_KEYS` ⇄ `ARMED_EVENT_ENTRY_KEYS`) because the Worker's parser drops
unlisted keys silently; the `armed` status chip is pinned between `lib/digest/todays-reporters.ts`
and its Worker mirror. Change both sides in the same commit (§14).

**Operational note — a restored Mac DB wedges the key.** Generations come from the local
`cloud_outbox`. Restore the Mac DB from a backup and the counter restarts lower than the one KV
holds, so every POST is refused as stale and the cloud stops hearing about arms — silently, since
`applied:false` is the normal reply to a replay. The fix is to clear the key once, after which the
next drain re-establishes it:

```bash
cd workers/cron && npx wrangler kv key delete armed-events --binding CRON_KV --remote   # binding CRON_KV, wrangler.toml; drop --remote to clear a local dev KV
```

**Post-deploy sequence (slice A ships Electron AND the Worker together).**

1. `cd workers/cron && npx wrangler deploy` — the resolver must be live before a v11 snapshot lands.
2. Run the snapshot script ONCE by hand so the first v11 snapshot exists within minutes instead of
   at the next 02:00 launchd run:
   `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx scripts/snapshot-state-to-r2.ts`.
   Until it lands the Worker degrades to held + watchlist (tested, not a failure).
3. Arm one real upcoming event and confirm both halves: `cloud_outbox.sent_at` is stamped on the
   Mac, and `GET /internal/armed-events` (with the cron secret) reports that generation.

## Scheduling conventions (from the Conventions section)

## Market-holiday gating of scheduled sends

`lib/calendar/market-holidays.ts` (+ a parity-tested Worker mirror) is the **single source** for NYSE
closures: `isMarketHoliday` / `isMarketClosed` / `nextTradingDay` / `shouldSendBriefingToday`.

- The daily digest + evening email **SKIP** on full closures.
- The Sunday briefing **SHIFTS to Monday** on a holiday Monday.
- The holiday list is hardcoded and verified vs nyse.com — **re-verify before extending past 2027**
  (watch the observed-day shift; early-close days are NOT holidays).

## Worker sibling fallbacks bubble upstream failures

The `fallback-digest.ts` error-counter pattern (`listErrors` / `articleErrors` / `lastError` →
`kind:"error"` when all attempts fail) is mirrored across **all** Worker fallbacks (briefing,
evening, earnings, calendar-enrich).

Any NEW fallback path must track + bubble errors — a bare `catch { console.warn() }` hid the 6-day
5/20 outage.

## Cloud-fallback travel hardening

1. The evening email **LIVE-fetches Gmail** (`fetchAndProcessNewArticles`, shared with the digest) so
   afternoon newsletters — invisible in the frozen 2am snapshot — appear.
2. The anomaly Yahoo fetch is batched via `spark` (`fetchLast2ClosesBatch`, ≤50/chunk) to stay under
   the **50-subrequest free-tier cap** that had silently killed the anomaly block.
   `MAX_ARTICLES_PER_RUN_EVENING = 6`.
3. Snapshot **v5** adds `notes` + `earningsBogeys` (rendered by `fallback-earnings.ts`).
4. `enrich-fail` is de-noised via `isBenignEnrichOutcome` — Mesh CGNAT makes the Mac unreachable from
   CF every tick, producing CF 1016.

**Verify-cloud gotcha**: `wrangler r2 object get --pipe` **CACHES** — confirm freshness via a raw
aws4fetch S3 GET (`Last-Modified`). See `memory/reference_r2_snapshot_debugging.md`.
