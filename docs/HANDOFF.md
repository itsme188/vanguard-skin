# Session Handoff — for Codex review

> Rolling file, overwritten at each session close. Past handoffs: `git log -p docs/HANDOFF.md`.
> Written by Claude Code so Codex can review changes and reasoning at full project context.

**Session date:** 2026-08-12 (day session, following the same-date corporate-actions session)

## 1. Goal + files changed

Two user-picked workstreams: (a) land the queued QA branches (PR #46 triage), (b) walk the 8 pending deep-QA decisions and implement the decided ones. A third emerged from (b): a valuation-engine defect found while validating a repair.

**QA landing (`554ca9a`, `89049a1`):** PR #46 (four fixer-night fixes) and the orphan `qa-deep-fixes-2026-08-12` classify-normalization commit merged with merge commits. PR #46 was first put through a high-effort multi-agent workflow review — 9 verified findings, 7 fixed immediately in `56cdd35`: `formatGeneratedAt` moved to `lib/calendar/date-utils.ts` and taught the SQLite `datetime('now')` shape (cache-hit GET fed it raw DB timestamps → wrong day after 8pm ET / Safari Invalid Date); POST `/api/analysis/narrative` rolls its rate-limit stamp back on generation failure (one transient AI error no longer bricks Refresh for 24h; pre-stamp kept for the concurrent-double-click guard); `NarrativeBlock` clears cross-scope `refreshError` and renders 429s in domain language from `retryAfter`; `ResearchFeedsView` throws on a `success:false` envelope instead of proceeding with stale sources, and the source-selectability predicate is one shared helper; `lib/compute/cost-basis-reconciliation.ts` got the same per-(account,security) latest-holdings fix PR #46 applied to `scenarios.ts` (regression test proves the old `keyBy:"account"` silently dropped staggered-date positions from the report).

**Decisions batch:** all 8 pending findings decided (each on the fixer's recommended option), recorded as `DECIDED:` plans in the local ledger; 4 remain for the nightly fixer (SPY-weight denominators, risk drawer ranking, empty bogeys, wash-sale labeling, actuals pre-print floor). Implemented today:

- **KRW chart labeling (`9ba9158`):** new `lib/chart/price-formatter.ts::formatChartPrice`; chart-level `localization.priceFormatter` (one seam covers axis, pill, price-lines, crosshair in LWC v5), currency threaded from `securities.currency` via `getChartableSecurities` and security-detail; `ChartMoney` sibling of `<Money>` for the React legend; `AddLevelPopover` labels. Values never converted — labels only. Known sibling left alone: `LevelsPanel` still $-labels native level prices (TODO'd; it carries a 2026-08-05/06 decision-trail comment).
- **Option duplicate contracts (`0d1d20f` + live repair):** `upsertSecurity` canonicalizes option-shaped symbols to OCC via extended `lib/import/occ-symbol.ts` (handles human, OCC, and IBKR DDMMMYY spellings; bare tickers never parse). `scripts/repair-duplicate-option-securities.ts` merged **359 duplicate pairs across 74 underlyings** (parse-based identity on root/expiry/right/strike — the QA finding's 22-trade estimate was trade-coincidence sampling only) across all 20 `security_id` FK tables, then recomputed tax lots. Verified: re-run finds 0 groups; 637 option securities remain; 0 duplicated trades. VACUUM-INTO backup in `data/backups/`.
- **Risk-metrics flow contamination — full arc (`2daa5b3`, `df6dc46`, `08cb046`):** shared `lib/compute/cash-flow-audit.ts` + dry-run repair script + data-confidence flag. First dry-run proposed 4 flow inserts; valuation-series review showed 3 were internal cash↔holdings shifts (smooth totals — inserting them would have corrupted TWR/XIRR), so the audit gained an external-flow-vs-internal-shift classification (total-value corroboration ≥50%, same sign). The user then confirmed the remaining candidate date had NO deposit — the real deposits that month are both recorded — which re-rooted the cause: **Phase 2 of `lib/compute/daily-valuation.ts` stamped ONE constant cash residual per anchor window, making recorded mid-window external flows invisible until the next anchor absorbed them.** A direct row repair was built, applied, and clobbered by the next recompute within the hour (derived rows; repair retired/deleted same day). Final fix `08cb046`: plug-era cash steps by `fetchNetFlowsByDate` (imported, not reimplemented — same sign convention and per-date netting the flow-adjusted return math uses; its `HAVING SUM != 0` makes zero-net journal days no-ops) within each anchor window, flows ON the anchor date excluded (already in the snapshot total), no-flow windows byte-identical single-UPDATE. Verified live: four historical flow windows (two Vanguard, two IBKR) now step on their true dates; blast radius 55 rows, every one tracing to a recorded flow row; recompute idempotent; flows audit proposes zero inserts.

## 2. Tests / E2E / deploy

- Suite **4,723 → 4,864** (446 files), green at every commit; run before each of the six substantive commits. December-repair, TWR, and transfer-sign canaries pass unadapted through the engine change.
- **Two Electron deploys** (notarized, installed, `:3099` health 200). The second was required because the first shipped before the engine fix — and the old-engine app's 30-min background sync re-clobbered the flow-stepped series *during* the second build window. Lesson pinned in memory: deploy the engine before recomputing, or expect to recompute twice. Final state: the packaged app's own sync **generates** the stepped series (durability by construction, not by repair).
- Post-deploy `database is locked` failures in 3 tests exposed a convention violation (they write to the live DB via the `@/lib/db` singleton) — TODO'd, not fixed.

## 3. Open concerns, rejected approaches, user decisions

- **Rejected: flow-row inserts for internal shifts** (would corrupt TWR/XIRR — the exact silent-heuristic failure the user's chosen option was meant to avoid). **Rejected: derived-row repair** (proven futile in-session). The engine fix is the only durable shape.
- **07-31 live-row misattribution** (TODO'd): a `data_quality='live'` valuation row shifted a large amount between cash and holdings and back on the next statement-anchored row — likely the money-market sweep classified as a holding on the live source. Own diagnosis item; the audit's internal-shift classification defuses it for risk purposes.
- **`--only <date>` / `--amount <n>` flags** exist on the flows repair script for any future user-confirmed insert; none needed today.
- **Sanitization concern raised to the user (unresolved):** several of today's commit messages and TODO.md entries carry real flow amounts and cash-balance figures, and the repo is public. Options presented: leave (some prior precedent exists) or scrub via history rewrite. Awaiting the user's call — Codex should not quote those figures onward.
- **Not addressed:** issues #34/#35 (untouched), corp-actions hardening batch, stale `origin/qa-auto-fixes-2026-08-06`/`-09` remote refs (verified empty, left).

## 4. Uncommitted changes / live-process state

- Working tree clean through `f8fcfec` + this handoff commit; all pushed. Merged QA branches deleted (local + remote `qa-auto-fixes-2026-08-12`). The nightly fixer's `../vanguard-skin-qa-fix` worktree stands (deliberate).
- Live: packaged app on `:3099` (carries everything through `08cb046`), healthy, sync idle via TWS; dev server on `:3000` if started will run current main. Worker untouched (no parity surfaces changed — chart/import/valuation work is Mac-side by architecture).
- Ledger state: 8 findings carry `decision_resolved: 2026-08-12`; KRW + option-dupe + risk-decomposition marked fixed (`merged-awaiting-deploy` → deployed); the 4 undone decided findings await tonight's fixer.
- Watch: tonight's fixer run implements the 4 remaining decided findings — check `git log main..qa-*` tomorrow; NBIS preview+recap both fired clean this morning (watch item closed).

## 5. Claude session link

https://claude.ai/code/session_01VgnKhe8BTTtLxRrYFx4jtF
