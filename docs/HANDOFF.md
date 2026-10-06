# Session Handoff — for Codex review

**Waiting on:** USER: (1) the two September 2026 Vanguard statements (the IBKR one has arrived; decision record `september-2026-statements`), then CLAUDE runs `import-monthly-statements` and the rehearsed tax-lot recompute; (2) rulings on the open points listed in `docs/plans/TODO.md` under "Overnight 2026-10-05 — open rulings and follow-ups"; (3) whether to deploy the Cloudflare Worker (`cd workers/cron && npx wrangler deploy`) — its source changed tonight and was NOT deployed; (4) the git-history purge decision for an account-number-shaped id that was removed at HEAD. CODEX: an independent review of the overnight range `2bf2deff..5540a26b` is welcome, especially the valuation back-step, the IBKR parser currency blocks and the recap-modal streaming.

> Rolling file, overwritten at each session close. Past handoffs: `git log -p docs/HANDOFF.md`.
> Written by Claude Code so Codex can review changes and reasoning at full project context.

**Session date:** 2026-10-05 evening, unattended overnight run on the user's instruction ("go through the to-do list and do as much of it as you can"). Authority given by the user for the night: merge to main, push, and deploy reviewed, green work; no live-database changes; no statement import.

## 1. What happened, in order

1. **QA rulings recorded.** The user ruled on 11 needs-decision findings; the local ledger and `docs/plans/TODO.md` carry them (`49d8c6d1`).
2. **Landing of PRs #96–#98** (17 nightly fixes): three read-only Opus reviews, one test repaired against the 10-02 statement-only-closes change, seven small review fixes (`456d157f`), sandbox smoke and browser pass, deployed.
3. **Backlog waves 1–3** (`163bf9e1` … `671fb8c3`): a read-only triage of every open TODO item produced 27 disjoint work units; parallel coding agents built them in a sibling worktree with one owner per file and no agent git writes. Two Codex review rounds and one Opus UI review found seven real defects, all fixed before landing.
4. **Wave 4** (`80897e5c`, `9c274e8c`): eight of the user's rulings built, a tests-only hardening pass, tooling. Reviewed, fixed, deployed.
5. **Wave 5** (`20bc3d55`, `5540a26b`): recap-modal streaming with cancel, zero-bar reader audit, sibling fixes, synthetic fixtures. Reviewed, fixed, deployed.
6. **Rehearsal** of the September IBKR import on a database copy (nothing live touched).

Range: `2bf2deff..5540a26b`, 36 commits, about 350 files.

## 2. Main changes by area (files are in the commits)

- **Valuation:** cash before the first resolvable anchor is back-stepped from the anchor through recorded external flows instead of reading zero (`lib/compute/daily-valuation.ts`). Floored at the account's first anchor.
- **Risk and options:** position-risk and options-greeks honor the whole account scope; as-of risk no longer reads prices after the as-of date; covered-call max loss counts uncovered shares and max profit is unlimited when shares exceed covered contracts; legacy eight-digit option expirations are normalized in the shared live-option predicate.
- **Import (protected area, changes limited to what TODO items and reviews asked):** IBKR Dividends, Fees and Deposits & Withdrawals convert non-USD blocks through the statement's own Total in USD, keep the native figure in note and source key, and skip a block with no conversion line, a zero total or mixed signs; USD rows are byte-identical (pinned). A blank trade price or fee is `undefined` with a plain warning. The stricter numeric validation from PR #97 applies to all parsers.
- **Tax lots:** split replay reads only split action types; one shared fail-closed tax-convention-pending helper; mixed long/short tests. The reconciliation script gained an explicit `--rollup` mode that fails closed and requires row-for-row agreement when both sides have the same row count.
- **Earnings and calendar:** composer fixes mirrored Mac and Worker (zero-consensus delta label, unit after rounding, symbol dedupe, one healed event reader with a repo guard); a cloud actual never replaces a local one (conflicts counted and logged); manual add refuses a slot that contradicts the known time, with its own acknowledgement separate from the vendor-supersede guard; hardcoded macro events survive a failed macro fetch; recap generation streams phases, can be cancelled, and makes at most two AI attempts.
- **AI gateway:** one retry on a rejected native structured-output request (Mac and Worker), four more schemas pinned, shared batch retry for classify-factors.
- **UI honesty, dates, privacy:** one shared mutation-result reader across the mutating handlers; user-facing "today" and window gates read the Eastern date; privacy-safe quantity nouns, a masked number input, palette subtitle masking; ScrollFade on the remaining wide tables with a repo guard; several small fixes (chat rail focus, risk drawer sort, neutral low-confidence beta tile, AI-unavailable state with manual retry, two-step confirm for a zero-value donation leg, Escape stacking).
- **Tests and tooling:** source-pin anchors throw when the anchor is missing; print-watch timing tests wait on conditions (the full-suite flake); a dry-run-default script reconciles QA-ledger `fix_status` against main; `--next nobody` in the coordination CLI; synthetic replacements for statement-looking rows.

## 3. Tests / E2E / deploy

| Step | Result |
|---|---|
| Landing of #96–#98 | full suite 10,575 passed; smoke 4/4; browser pass 8 of 10 (one miss fixed later, one partial noted); deployed |
| Waves 1–4 | full suite 10,917 passed; smoke 4/4 twice; two browser passes (13 of 15 with 2 partial; 10 of 11 with 1 unreachable); deployed |
| Wave 5 | full suite 10,981 passed, 0 failed; smoke 4/4; browser pass 7/7; deployed |
| Type-check | clean before every commit to main |
| Deploys | three, all through `npm run deploy`. The third failed once at the build step (font download) and succeeded on retry. Final build id is in the coordination register checkpoint for task `overnight-backlog-2026-10-05`. |

## 4. Open concerns, rejected approaches, decisions

- **Not built on purpose:** the history-derived time for slot-less vendor earnings rows. It was built, then removed in review: for a slot-less row the accept floor, enrichment window and recap floor read the stored time, so one past print could open those gates early. Only the "time unknown" rendering for a missing time shipped. Needs a second ruling.
- **Stop-and-report items** (existing tests pin current behaviour): cash for rows before an account's very first anchor; the equal-date split guard in the shared synthetic-close guard; print-watch `forced_open_at` on merge.
- **Worker not deployed.** Seven Worker source files changed (formatting parity, armed-events parser derivation, AI retry). The Worker could not be type-checked locally (its own dependencies are not installed) and a cloud deploy was outside the night's stated authority. Until it is deployed, Mac and Worker differ in two display strings (zero-consensus delta, compact unit at the rounding boundary).
- **Deploy wrapper hazard:** it quits the live app before building, so a failed build leaves the app down with the old build installed. Seen once tonight (about fifteen minutes of downtime). Worth changing to build first and quit only before install.
- **Pre-existing, now recorded:** Mac and Worker compute different no-marker digest fallback windows; one held name has no cached price bars, so its chart is empty until TWS backfills.
- **Privacy:** an account-number-shaped id and statement-looking rows were replaced with synthetic data at HEAD in tests and two docs. They remain in git history; other files with similar rows are listed in the TODO entry. The purge is the user's decision.
- **Rehearsal of the September IBKR import (copy only):** parsed with no warnings, no excluded rows, no duplicate twins; lots matched the statement for every position; recompute was idempotent on the copy; valuation on the statement date matched the statement. Observations for the real run: the recompute (not the import) is the large change; a handful of symbols show a realized-result difference versus the statement's own summary that was not root-caused; imported commissions fall short of the statement line by about the two foreign-currency commissions, which are stored in native currency.

## 5. State after the session

Main = origin/main at the handoff commit. Worktrees: only the nightly fixer's `../vanguard-skin-qa-fix`. Open PRs: none. Local and remote `qa-*` branches whose work is merged are still present (deleting them needs the user's OK). No dev servers or sandboxes running; no locks held. The live database was read once (read-only copy) and never written by this session.

## 6. Agent

Claude Code (Claude Opus 5.5, 1M context) — https://claude.ai/code/session_013LutcaXwZipndHW2VcrbmP
