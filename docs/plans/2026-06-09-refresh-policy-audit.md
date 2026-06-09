# Background / Server-Side Refresh Policy Audit — 2026-06-09

Closes the 2026-04-30 TODO item "Background / server-side refresh policy audit":
which side (Mac launchd vs Cloudflare Worker cron vs in-app) owns each job, and
whether the four named candidate gaps (factor cache, risk roll-up, weekend
benchmark refresh, level scans without TWS) need work.

## Job ownership matrix

| Job | Primary owner | Cloud fallback | Trigger / cadence |
|---|---|---|---|
| Sunday briefing | Mac launchd (`weekly-email`, et-gate 16:30 ET Sun+Mon) | Worker `runFallbackBriefing` @ 16:45 ET tick | Mac-first tick offset (2026-06-09) |
| Daily digest | Mac launchd (`daily-digest`, 8:45 ET M-F) | Worker `runFallbackDigest` @ 9:00 ET tick | Mac-first tick offset |
| Evening email | Mac launchd (`evening-email`, M-Th 19:00 / F 17:30 ET) | Worker `runFallbackEvening` @ 19:15 / 17:45 ET ticks | Mac-first tick offset |
| Earnings preview/recap sweep | Mac launchd (`calendar-enrich` wrapper → `/api/cron/earnings-sweep`, 15 min) | Worker `fallback-earnings` (every tick, self-gated M-F 05:00–20:00 ET) | marker dance per (phase, eventId) |
| Calendar enrichment | Mac launchd (`calendar-enrich`, 15 min, M-F 9:30–18:00 ET) | Worker `calendar-enrich` (flag-gated `CLOUD_ENRICH_ENABLED`) | TWS-always-wins reconcile |
| Newsletter ingest | Mac launchd (`research-sync`, 90 min, M-F 9–19 ET) + in-app hook on Research mount/refocus | Worker `newsletter-fetch` (hourly, skips when `mac-recent-newsletter-sync` marker alive) | Mac reconciles KV on wake |
| Level scans + Pushover | Mac auto-refresh Step 6 (`detectAndFireAlerts`) | Worker `level-scan` (15 min market hours, static levels only, skips when `mac-recent-scan` alive) | Tier 4a; MA-based levels Mac-only (accepted) |
| Portfolio positions/prices | Mac TWS auto-refresh (connect + 30-min background) → IBKR Web API OAuth fallback when TWS down | Worker reads live IBKR book into briefing/earnings fallbacks (read-only) | |
| Benchmark prices | Mac auto-refresh Step 5 (TWS, full tier) + Yahoo top-off on BOTH tiers (`yahoo-benchmarks.ts`, 2026-06-08) | none (Worker has no DB) | heals on next app open |
| Quote enrichment (IV/HV/52wk/div yield) | Mac IBKR OAuth refresh (`fetchAndStoreQuotes`) + Finnhub yield batch (2026-06-09) | none | best-effort |
| State snapshot → R2 | Mac launchd (`state-snapshot`, 2 AM) | — (it IS the fallback's input) | |
| Nightly QA | Mac launchd (`nightly-qa`, 2 AM) | none | |
| Security classification (sector/fund) | Auto: import post-commit + classify button; option sectors: auto-refresh **Step 2.5** (2026-06-09) | none | |
| Factor classification | **Auto-refresh Step 2.6 (NEW 2026-06-09)** + classify-factors button + Sunday briefing pre-gen path | none | was manual-only — the audited gap |
| Macro themes + narratives | Sunday briefing pre-gen + on-demand cached (24h rate limits) | none | |
| Risk-free rate | Piggy-backed on daily-digest wrapper (FRED, 48h TTL) | falls back to cache | |

## The four named candidates — decisions

1. **Factor cache** — REAL GAP, FIXED. Factor classification ran only when the
   user clicked Classify (or the one-off script). New positions silently
   degraded scenarios (multiplier 0), the factor heatmap, and macro-tilt
   contributors. Now wired as auto-refresh **Step 2.6** (full tier, after the
   option-sector pass): `classifyFactors` is incremental by construction and
   early-returns before any Claude call when nothing is unclassified, so the
   steady-state cost is one local SQL query per full refresh.

2. **Risk roll-up** — NO ACTION. `computeRiskMetrics` / `computePositionRisk` /
   `computeFactorAnalysis` are computed per-request from `daily_valuations` +
   `prices` (already maintained by the pipelines above). Single-user, sub-second
   computes — caching/scheduling would add staleness risk for zero latency win.
   The expensive AI layers on top (narratives, macro themes) already have their
   own cache + Sunday pre-generation.

3. **Weekend benchmark refresh** — NO ACTION (accepted gap). `benchmark_prices`
   tops up via Yahoo on every auto-refresh tick (both tiers) since 2026-06-08.
   When the app is fully closed there is no writer, but nothing reads
   benchmarks while the app is closed either; data heals on next open before
   any consumer renders. The Worker can't write the Mac's SQLite, and a
   KV-mirror just for weekend benchmark closes isn't worth the moving parts.

4. **Level scans without TWS** — ALREADY CLOSED (Tier 4a, 2026-05-11). Worker
   scans static levels from the R2 snapshot + Yahoo 1-min prices and fires
   Pushover when the Mac is asleep; Mac reconciles `cloud-fired-level-*` KV on
   wake. MA-resolved levels remain Mac-only by design (need `ohlcv_bars`) —
   documented, accepted.

## Cross-cutting fix shipped with this audit

**Mac-first tick offset (2026-06-09).** Every Worker email dispatch previously
shared the Mac's target tick; since Mesh primary always fast-fails (CF 1016),
the Worker claimed `cloud-attempting` within seconds and the awake Mac lost the
race every day (6/3–6/9: all digests + evenings shipped the thinner cloud
composition). All Worker dispatch minutes now sit one */15 tick after the Mac's
launchd window. See `workers/cron/wrangler.toml` + `parseJobFromClock`.
**Requires `wrangler deploy` to take effect.**
