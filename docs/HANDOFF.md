**Waiting on:** USER: four live checks of the Gains at risk broker paths not yet seen with the broker connected (a pull while live quotes are streaming, a Get quote clicked during a pull, a delayed or closed-session label, an unlisted strike), and a look at the new strike picker, row notes and per-$1,000 column on the next real pull (`docs/plans/TODO.md` G3a, G4a). Nothing else from this session. Carried over from earlier sessions: the open Analysis tab decisions and the other `decision` records in the register (`npm run inbox`).

# Session Handoff — for Codex review

> Rolling file, overwritten at each session close. Past handoffs: `git log -p docs/HANDOFF.md`.

Session: 2026-11-23 → 2026-11-25, exposure review, then Gains at risk (three steps). Agents: Claude (Fable 5.2 planning, ruling and reviewing as controller); Opus 5.5 subagents wrote the specs and plans from the controller's rulings, built every unit with one owner per file, and ran the code in independent reviews. Codex reviewed each spec and plan read-only (one round each).

## 1. Goal and files changed

Goal: the owner asked for tools to judge how well protected the book is against a market fall, a single-name move, and what a candidate option would change. One new Analysis view, "Gains at risk" (`/dashboard/analysis?view=gains`), built in three steps. The session began with a handoff of 17 Analysis-tab exposure bugs (fixed and landed at `a9ada9e4`, recorded in `docs/DECISIONS.md` 2026-11-23 and 2026-11-24).

Landed on `main` (53 commits after `a9ada9e4`; final code commit `9cc6dc7c`, final docs commit before this file `b534e667`):

- **Step 1, the line and the table** (through `61f838f6`). Design `docs/superpowers/specs/2026-11-24-gains-at-risk-design.md`; plans `docs/superpowers/plans/2026-11-24-gains-at-risk-step1.md` and `-step1-addendum-betas.md`.
  - Engine: `lib/compute/gains-at-risk.ts`, `driver-beta.ts`, `security-regression.ts` (`computeDailyBarRegression`), `year-gain.ts`, `scenario-positions.ts`, `option-reprice.ts` (`valuationDate`, `modelWhenUnpriced`), `flow-adjusted.ts` (`fetchNetFlowsUsdByDate`), `lib/securities/leveraged-tracked-index.ts`.
  - Daily bars: `lib/tws/daily-bar-capture.ts` (sync Step 7), `scripts/backfill-daily-bars.ts`, `lib/mutations/ohlcv.ts`, `lib/queries/ohlcv.ts`, `lib/tws/auto-refresh.ts`.
  - Route and page: `app/api/compute/gains-at-risk/route.ts`, `lib/analysis/gains-at-risk-{input,constants,scope,view}.ts`, `lib/analysis/view-param.ts`, `app/dashboard/components/gains-at-risk/GainsAtRisk{Section,View,Chart}.tsx`.
- **Step 2, try a position** (through `5bcd44c3`). Design `docs/superpowers/specs/2026-11-24-gains-at-risk-step2-trial-positions-design.md`; plan `docs/superpowers/plans/2026-11-24-gains-at-risk-step2.md`.
  - `lib/compute/gains-at-risk-trial.ts`, `lib/tws/option-quote.ts`, `lib/calendar/market-session.ts`, `lib/calendar/market-holidays.ts` (early closes), routes `app/api/tws/option-quote/`, `app/api/tws/daily-bars/ensure/`, `app/api/compute/gains-at-risk/trial-entry/`, `lib/analysis/gains-at-risk-trial-view.ts`, `TrialPositions{Provider,Form,List}.tsx`, `lib/ui/positions-freshness-label.ts` (reworded).
- **Step 3, one stock as the driver and candidate options on one budget** (through `ea0873ed`), then a round after the owner's first real pull (`dbdba8db`, `c91d1c0e`) and tracked-index seeds (`9cc6dc7c`). Design `docs/superpowers/specs/2026-11-25-gains-at-risk-step3-candidates-design.md`; plan `docs/superpowers/plans/2026-11-25-gains-at-risk-step3.md`.
  - Engine: `lib/compute/gains-at-risk.ts` (driver kind, single-name ladder, two sides per row, candidate pass), `gains-at-risk-drivers.ts`, `gains-at-risk-candidates.ts`, `gains-at-risk-candidate-check.ts`, `gains-at-risk-candidate-quotes.ts`, `lib/analysis/gains-at-risk-candidate-money.ts` (exact scaled integers).
  - Broker: `lib/tws/market-data-type.ts` (the one setter, with a counter), `option-chain-reader.ts`, `option-quote-batch.ts`, `option-quote.ts` (bounded lock, `brokerExpiryDay`); one-line setter swaps in `snapshot.ts`, `atm-straddle.ts`, `streaming.ts`.
  - Routes: `app/api/compute/gains-at-risk/{single-name-drivers,candidates}/route.ts`, `app/api/tws/option-candidates/{chain,quotes}/route.ts`, `lib/analysis/gains-at-risk-candidates-input.ts`.
  - Page: `DriverControl.tsx`, `DriverChoiceProvider.tsx`, `CandidatesProvider.tsx`, `Candidate{Section,Picker,Table}.tsx`, `lib/analysis/gains-at-risk-candidates-view.ts`.
- Docs: `CLAUDE.md` (three Gains at risk rule blocks), `docs/DECISIONS.md` (2026-11-23, 11-24, 11-24 late, 11-25, 11-25 later), `docs/plans/TODO.md` (G1 to G9, G3a, G3b, G4a, G4b).

No migration, no schema change, no new dependency, no Worker change.

## 2. Checks run and results

- `bash scripts/verify.sh full --base main` passed on the final code in the worktree and in the main checkout (about 1,880 files and 23,160 tests, 0 failed). The commits after `9cc6dc7c` are docs only; the suite was run again on the final commit in both checkouts at close.
- Each unit had an independent review that ran the code with its own synthetic book or fake broker. Examples of what those reviews established: option payoffs at expiry match hand arithmetic to the cent; adding candidates changes no book or trial figure; sizing conserves the budget exactly; every malformed route body is refused with zero broker requests and zero writes; the sync's three broker files changed by a one-line setter swap with no behaviour change; index-mode results are byte-identical to the pre-step-3 fixtures (checked against the engine extracted from the earlier commit).
- Codex reviews (read-only): REVISE on every spec and plan (step 3: 11 findings on the spec, 10 on the plan); every finding was folded in as a recorded ruling.
- Sandbox browser passes (database copy, port 3090, broker disconnected) for each step: the page in index and one-stock mode, a scope change, privacy mode, phone width, the trial list, the Compare options section's disconnected state and guidance. Two defects found there and fixed (a sideways scroll at phone width; no explanation when the stress scope holds nothing that moves with the chosen driver).
- Live, by the owner, 2026-11-25: the first real option-chain pull and quote pull worked (expiries listed, a near-dated expiry listed strikes, fifteen contracts priced and labelled live, sizing and Add matched), and the step 2 Get quote filled live. The server log showed no error from any new route.
- Deploys: four on 2026-11-25. The last is `npm run deploy` from `b534e667`: build id matches on both sides, codesign verified, a fresh listener answers on :3099. One attempt in between was refused at pre-flight (the TODO file was not in the newest commit) before anything was built; the app stayed up.

## 3. Open concerns, rejected approaches, user decisions

- **Owner decisions:** one Gains at risk view in three steps; the year's gain is measured on every account and its label says nothing about its use; unpriced options are flagged, priced by the model and can be overridden; "Get quote" over typed-only prices; candidates compared on a same-budget basis; the whole candidate table computed in one server call; tracked-index seeds for three leveraged funds confirmed.
- **Controller rulings worth a second look** (all recorded in `docs/DECISIONS.md` with why and cost if wrong): no beta estimate, ever (a name with no measured link says so); the selloff case is an assumption and is labelled as one; index drivers stay falls-only; an option that expires before the valuation date is counted at the worse of two orders (cautious, and it makes near-dated candidates look poor until the date is moved; the row now says so); candidates are costed at the mid; a pull never starts during a sync and never abandons a snapshot in flight; a broker contract id decides a holdings match when both sides have one.
- **Rejected:** a heuristic or sector-average beta; `prices` rows or `benchmark_prices` as regression input (sync-time snapshots, not closes); a page that loops the existing routes per candidate (rows could be measured on different books); a lock around the sync pipeline (a counter plus one retry instead); comparing a broker expiry as text (the library's decoder can leave a time on it).
- **Not verified:** four broker paths listed in "Waiting on"; the round-2 strike picker, price marker, row note and per-$1,000 column with real quotes; the installed app clicked through end to end by an agent (the owner used it for the live pull).
- **Known limits:** a leveraged fund with no confirmed seed is listed as not modelled; one seeded tracked fund has no daily bars until the next sync's capture step fetches it; mutual funds have no daily bars and so no measured link; a trial underlying priced only from daily bars is not offered as a driver.
- **Decided, not built:** a rise in an index (needs a meaning for the selloff case); a cost-at-the-ask column; written options in the candidate table; a live underlying price beside the strike picker (`docs/plans/TODO.md` G4b); older items G5 to G9.

## 4. Uncommitted changes and live-process state (after the deploy)

- Main checkout and this session's worktree: clean. `main` == `origin/main`.
- Branch `claude/analysis-exposure-handoff-47b6ce` is fully merged into `main` (fast-forward); the branch and its worktree (`.claude/worktrees/portfolio-assistant-review-7148e7`) still exist for the owner to remove.
- Other worktrees, not this session's: `vanguard-skin-bogey-intake`, `-menu`, `-perf`, `-qa-fix`.
- Open PRs, not this session's: the nightly QA auto-fix PRs (#192 to #196 and older).
- Sandbox for task `gains-at-risk-step1`: stopped. No dev server, no background job, no agent running.
- Installed app: the build from `b534e667`, running on :3099.
- Storage report: scratch files older than 7 days exist (trim is optional); the USB copy was last synced 9 days before close.

## 5. Agent identity and session link

Claude Code (Claude Fable 5.2 as controller; Opus 5.5 subagents). Session link: not exposed in this session's environment.
