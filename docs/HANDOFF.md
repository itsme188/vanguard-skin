# Session Handoff — for Codex review

> Rolling file, overwritten at each session close. Past handoffs: `git log -p docs/HANDOFF.md`.
> Written by Claude Code so Codex can review changes and reasoning at full project context.

**Session date:** 2026-08-12 (evening session, following the same-date day session)

## 1. Goal + files changed

Three user-picked items, executed via subagent-driven development (fresh implementer per task, per-task spec+quality review, fix rounds with scoped re-review, final whole-branch review — all gates cleared):

**LevelsPanel native-currency labels (`ec57213`):** the deliberately-left sibling of the day session's KRW chart-axis fix. New `lib/chart/price-formatter.ts::formatLevelPrice` — a thin wrapper, NOT a bare `formatChartPrice` call, because the brief's two requirements conflicted: `formatChartPrice`'s USD branch renders ungrouped (chart-pill style) while LevelsPanel's pre-existing USD output is grouped via `formatUSDPrecise`; the wrapper delegates non-USD → `formatChartPrice`, USD → `formatUSDPrecise`, with a regression test asserting both the equality and the inequality that motivated it. Currency threaded page → MarketDataPanel → LevelsPanel → SuggestedLevels. ATR lines deliberately keep `$` (genuine USD conversions). Browser E2E on :3000: SPY byte-identical, KRW level renders `₩820,000` matching the chart axis, test level hard-deleted after, zero console errors. Four sibling surfaces with hardcoded `$` on level prices (NearbyLevelsCard + three outbound composers) filed in TODO — they need currency threading through `briefing-levels` queries and composer row types.

**Live-DB test leak (`8736d2c`):** `analysis-macro-themes`, `cash-deploy-theme-aware`, `scenario-recipes-live-now` imported the production `@/lib/db` singleton (the `database is locked` failures of the day session). Converted to the settings-email-recipients getter-mock pattern (`vi.hoisted` + `get db()` — the getter avoids the stale-first-instance trap). Audit: zero remaining un-mocked singleton usages under tests/. Collateral finding: ALL 15 `analysis_macro_themes` rows for scope `all` are test pollution (`model_used='v1'`); the real weekly themes for that scope were silently overwritten via `ON CONFLICT DO UPDATE` and are unrecoverable. Filed in TODO; remedy is delete + regenerate via the app, pending user approval (live-data delete).

**Cash/holdings split normalization (`6c1e34d`, `8044154`, `59e885c`) — the session's main work.** The day session's TODO item hypothesized the live snapshot source counts the sweep fund as a holding. The diagnosis INVERTED that: `daily_valuations.cash_balance` is a residual (`snapshot_total − holdings_value`, Phase 2), the Plaid path folds VMFXX into cash and never reports the Treasuries at all, while the canonical statement path writes both as holdings (by documented design). So statement-anchored days had the truthful split, and every ordinary Plaid day silently parked the sweep AND the bonds inside "cash" — the month-end flip was the statement briefly removing the blindness. The `data_quality='live'` label was a red herring (pure freshness stamp; the 07-31 holdings actually came from the canonical monthly import). User decision: **full normalization** — sweep = cash everywhere, bonds = holdings everywhere. Implementation: new `lib/compute/cash-equivalents.ts` predicate (`fund_category` 'Cash Equivalent'/'money market' OR `security_type` money_market — no symbol allowlists; classification layer owns identity); Phase 1 excludes cash-equivalents from value/counts/quality (their value re-enters via the untouched Phase 2 residual); statement-sourced bond rows are carried into Plaid-snapshot days, gated on (plaid-row present AND zero bond rows), with the statement-authority source class extracted to new `lib/db/holding-sources.ts` (SIX prefixes — the final review named four missing beyond `canonical:`, the fix sweep found a fifth, `ibkr:holding:`).

## 2. Tests / E2E / deploy

- Suite **4,864 → 4,904** (449 files), green at every commit; TDD RED/GREEN evidence captured for the engine work, including an anti-vacuity proof (gate temporarily disabled → both assertion legs fail with the exact phantom-cash spike the fix prevents).
- **Scratch-copy live verification** (VACUUM-INTO copy, never the live DB): the month-end split flip shrank ~4× to just the structural plug drift (intra-window sweep growth invisible to any daily source, corrected at each anchor); the 07-31 anchored residual lands exactly on true-cash-plus-sweep; holdings counts smooth; **anchor totals exact at every monthly snapshot**; the bond-holding account has zero negative-cash rows — which also empirically settles the one assumption the reviews could not verify (Plaid's account total DOES include institution-held Treasuries; now regression-locked by the Plaid-anchor+carried-bond test).
- **Perf benchmarked, not assumed:** full-history recompute 229.4s (old engine) vs 238.1s (new) on identical scratch copies — no regression; the ~4-minute baseline is pre-existing (TODO'd as an observation).
- **NOT deployed, NOT pushed.** All five commits are local on `main`. The packaged app on :3099 still runs the old engine; its syncs keep regenerating old-semantics rows until the next deploy, after which the first sync regenerates the normalized series (durable by construction — deploy-before-recompute lesson honored by doing NO live recompute this session).

## 3. Open concerns, rejected approaches, user decisions

- **User decisions this session:** (1) full normalization (over sweep-only, over sweep-as-holding, over assessment-only); (2) the three-item session scope itself.
- **Rejected:** bare `formatChartPrice` swap in LevelsPanel (breaks USD byte-identity); manual Phase 1 cash adds (residual handles it); statement-import changes (docs/tests codify VMFXX-as-holding there; the valuation layer is the seam).
- **Highest-value follow-up (verified, filed):** `lib/queries/chat-tools.ts::getCashEstimates` is a twin of the fixed bug — same unfiltered residual, feeding the IBKR chat persona's `cashPct`/`bullishnessScore`. Fix shape now proven; copy it.
- **Also filed:** allocation/AI-context surfaces missing the cash-equivalent concept; ~9 disagreeing hand-rolled `money_market` string lists (one case-sensitive, violating convention); post-deploy chore (flows-audit re-run expecting the internal-shift candidates to disappear, then refresh `cash-flow-audit.ts`'s now-stale header + two stale prefix comments); KRW hero mixed-basis product call; carried-bond position age not degrading `data_quality` (accepted trade-off).
- **Deliberately skipped:** `8736d2c` lacks the commit trailers (fixing a middle commit means history rewrite — not worth it).

## 4. Uncommitted changes / live-process state

- Working tree at session close: TODO reconciliation + this handoff (committed as the final chore commit). Five code commits ahead of `origin/main`: `ec57213`, `8736d2c`, `6c1e34d`, `8044154`, `59e885c`. **Push + Electron deploy await user approval** (or `/session-end`).
- Live: packaged app on :3099 (old engine, healthy); dev server on :3000 (current code, used for E2E). Worker untouched (no parity surfaces — chart/tests/valuation are Mac-side by architecture).
- Fixer collision note: tonight's nightly fixer implements the 4 remaining decided QA findings — none overlap this session's files (verified against the decided list: SPY-weights, risk-drawer ranking, empty bogeys, wash-sale labeling, actuals floor).

## 5. Claude session link

https://claude.ai/code/session_017NKt4YXphQzYooMAFA5Bxp
