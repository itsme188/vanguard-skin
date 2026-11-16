**Waiting on:** USER: rule on the open Analysis tab decisions (register record `analysis-tab-owner-decisions`; `docs/plans/TODO.md` "Analysis tab follow-ups" A2-A9) and confirm the 2025 return used the IBKR 1099-B (record `ibkr-1099b-2025-confirm`). CLAUDE: run a Codex review of the Plaid session-dating plan, then build it (record `plaid-session-dating`).

# Session Handoff — for Codex review

> Rolling file, overwritten at each session close. Past handoffs: `git log -p docs/HANDOFF.md`.

Session: 2026-11-15 → 2026-11-16, Analysis tab deep session. Agent: Claude (Fable 5.2 orchestrating; Opus 5.5 subagents diagnosed, built and reviewed).

## 1. Goal and files changed

Goal: diagnose the Analysis tab (Workspace, Diagnostics, Performance, Defense, Giving, Trade Reviews), fix what needed no ruling, bring every judgement call to the owner with context, then build the rulings.

Landed as one squash merge: PR #184, `b58dc103` on `main` (193 files). The areas, by path:

- **Performance:** `lib/compute/flow-adjusted.ts`, `lib/compute/risk.ts`, `lib/compute/xirr.ts`, `lib/compute/period-attribution.ts`, `lib/compute/cash-flow-audit.ts`, `lib/compute/benchmark-label.ts` (new), the Performance view components.
- **Workspace:** `lib/compute/exposure-delta.ts`, `lib/compute/cash-deploy.ts`, `app/dashboard/components/analysis/{WhatIfCalculator,CashDeployCard,TrustStrip,TrustStripDrawer}.tsx`, `app/api/analysis/cash-deploy/route.ts`.
- **Diagnostics:** `lib/queries/concentration-universe.ts`, `lib/queries/analysis.ts`, `lib/queries/drill-down.ts`, `lib/compute/scenario-recipes.ts`, `lib/compute/scenarios.ts`, `app/dashboard/components/{RiskMetrics,PositionRisk,ScenarioModeling}.tsx`, `app/dashboard/components/analysis/ClassificationCard.tsx`, `app/api/compute/position-risk/route.ts`.
- **Defense:** `lib/compute/hedging.ts`, `app/dashboard/components/{DefenseView,DefenseTables}.tsx`.
- **Giving:** `lib/queries/giving-view.ts`, `lib/mutations/donation-links.ts`, `app/dashboard/components/giving/{GivingView,GivingYearSection}.tsx`.
- **AI:** `lib/compute/macro-themes.ts`, `lib/compute/analysis-narratives.ts`, the gateway usage log line, the classifiers' cut-off checks.
- **Trade reviews (correctness only; feature on hold):** `lib/trade-review/{market-context,prompt,questions}.ts` and the review pipeline.
- **Scope:** `lib/analysis/view-param.ts`, `app/dashboard/analysis/page.tsx`.
- **Repair scripts (new, rehearsable):** `scripts/repair-roth-december-snapshots.ts`, `scripts/repair-gift-month-returns.ts`, `scripts/repair-option-exercise-basis.ts`, `scripts/repair-ibkr-mixed-trade-splits.ts`.
- **Docs:** `CLAUDE.md`, `docs/DECISIONS.md` (entry 2026-11-15 and 2026-11-16), `docs/plans/TODO.md`.

No migration. No Worker change.

## 2. Checks run and results

- `bash scripts/verify.sh full --base main` on the branch tip: 1,792 test files, 21,576 tests passed, 0 failed (692 more tests than the base). Rerun in the main checkout on the merge commit: see section 4.
- `npx tsc --noEmit -p .`: clean. `npx next build`: compiled.
- Independent run-the-code review after each of three waves (separate Opus agents), plus one review that rehearsed three data repairs together on a database copy.
- Browser: four passes on the isolated sandbox (all four scopes, phone width, privacy mode). The third found a real bug the tests and two reviewers had missed (a fund offered for a sector it barely holds); fixed and re-checked.
- Deploy: `npm run deploy` from `main` at `b58dc103`. Notarization succeeded; installed build id matches; a fresh listener answers on :3099. The installed app was NOT clicked through after the deploy (the login needs the owner's password); the same code was browser-checked on the sandbox.

## 3. Open concerns, rejected approaches, owner decisions

- **The 2026-08-13 seam rule is reversed in part.** The old rule carried every month-end flat and erased real market days. The narrowed rule counts a few closed-day steps as market moves until the Plaid dating fix lands. An early claim that "monthly returns match the statement" proves the new rule was wrong (it holds for any rule) and is corrected in DECISIONS.
- **Plaid rows are dated one session late** (balances, quantities) and mutual fund prices one session early. Ruled and planned (gitignored plan in `docs/private/`), not reviewed by Codex, not built. Rebuilding live-day values from holdings times close was rejected for now: a simulation was worse.
- **Recommendations that measurement overturned:** a cheaper model class for the tab's AI calls (slower, less consistent); the holdings-times-close valuation; the first build of "do not fill a sector held short" (it divided long-only dollars by the net basis and left half the cash unplaced; now measured on a long-only book).
- **Defense credits nothing for a hedge with no measurable beta.** On the real book those are long-established sector funds whose price history the app never collected. Owner decision pending on how to credit them.
- **Five live data repairs were applied** with the owner's explicit go-ahead, each rehearsed on a copy first and backed up: two annual-summary snapshot rows, eleven gift-month returns, twelve option exercise rows, two trades coded both closing and opening, one gift's lots. Realized gain for two filed years changed in the app; after the repair those lines match the brokers' own forms.
- **Found, not fixed:** a 2021 transfer into the taxable account was never imported; a sale cannot choose its lots, so realized gains differ from the broker's minimum-tax relief; the importers still store an option exercise unpriced (inside the import pipeline, needs an explicit yes); the cash lines count cash-equivalent funds only, not broker cash balances.
- **Trade Reviews are on hold** by owner ruling, pending their own session.
- Codex's automatic review of PR #184 was still running when the PR merged. Any finding gets a follow-up change on `main`.

## 4. Uncommitted changes and live-process state (after the deploy)

- `main` == `origin/main`. Main checkout clean. Installed app: build of `b58dc103`, running on :3099.
- Full verification in the main checkout on the merge commit: 1,792 test files, 21,578 tests passed, 0 failed (result passed). A docs-only handoff commit follows it.
- Worktree `.claude/worktrees/portfolio-assistant-review-7148e7` on the merged branch `claude/analysis-tab-deep-session-bd9283` (clean; safe to remove). Other worktrees untouched: `vanguard-skin-menu`, `vanguard-skin-perf`, `vanguard-skin-qa-fix`, `vanguard-skin-todo-reconcile`.
- No dev server or sandbox left running. Open PRs from this session: none.
- The stored Analysis narratives read as "inputs changed" until regenerated (owner approved the regeneration; not yet run).
- Data Health lists more items than before: the lot-drift scan runs again now that the stored lots are current. Six critical lot drifts predate this session.

## 5. Agent identity and session

Claude Code (Fable 5.2), local desktop session `34850a9b-a750-442f-8ac2-f3d48ad4499f`. No public session link.
