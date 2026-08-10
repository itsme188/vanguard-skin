# Session Handoff — for Codex review

> Rolling file, overwritten at each `/session-end`. Past handoffs: `git log -p docs/HANDOFF.md`.
> Written by Claude Code so Codex can review changes and reasoning at full project context.

**Session date:** 2026-08-10 (evening session)

## 1. Goal + files changed

Two goals: (a) harden the Claude↔Codex collaboration conventions; (b) fix the Analysis performance headline TWR (user-reported, root-caused the prior session).

Files changed:
- `.claude/session-end.md` — handoff step moved after the Electron deploy (reports final state), GitHub issue-closeout step, Node-20 PATH prefix now mandatory on the deploy command (live-discovered failure, see §3).
- `.claude/session-start.md` (new) + `~/.claude/commands/session-start.md` (new, user-level) + `.agents/skills/session-start/SKILL.md` (new, thin pointer) — `/session-start` triage ritual ending in a pick-what-to-work-on menu.
- `.agents/skills/session-end/SKILL.md` — drift patched (handoff + issue-closeout steps added).
- `docs/superpowers/plans/2026-08-10-twr-december-repair.md` (new) — forensics + two-task SDD plan.
- `scripts/repair-december-snapshots.ts` (new) + `tests/scripts/repair-december-snapshots.test.ts` (new, 19 tests).
- `lib/compute/twr.ts` — `PortfolioTwrResult.isPartial` surfaced; `TwrOptions.accountIds` multi-account scoping (all five aggregate query sites); empty-scope guard.
- `app/dashboard/components/PerformanceView.tsx` — `resolveScope` replaces `resolveScopeToSingleId`; partial-coverage caption; per-account coverage windows; ET-anchored date math.
- `tests/compute/twr.test.ts` — 6 new tests (30 total in file).
- `docs/plans/TODO.md` — reconciled (TWR item closed; new import-dedupe conflict-warning item).

## 2. Tests / E2E / deploy

- Full suite in the SDD worktree: 4,593 passed / 3 pre-existing env-gap failures (`tests/ai/generate.test.ts`, missing `ANTHROPIC_API_KEY` — present on main too).
- `npx next build` clean (Node-20 PATH).
- Live data repair applied: dry-run showed exactly the 4 forecast December mismatches, 0 non-December; backup taken; idempotence re-run clean.
- Browser E2E (dev :3000): headline inside the per-account component range on every period (YTD/3Y/5Y/All), both total and annualized; partial-coverage caption fires exactly where account-inception dates truncate coverage; zero console errors.
- Electron deploy: FIRST ATTEMPT FAILED (`ERR_DLOPEN_FAILED` — bare `npm run electron:deploy` runs `next build` under shell-default Node 26, better-sqlite3 binary is Node-20). Retry with `PATH=/opt/homebrew/opt/node@20/bin:$PATH` succeeded: installed to /Applications, relaunched, fresh server healthy on :3099.

## 3. Open concerns, rejected approaches, user decisions

- **Root cause verdict (December TWR):** import defect, NOT Vanguard annual-statement semantics. Four December rows (2022–2025) came from an early CSV draft carrying annual-summary rows; the corrected re-import was silently skipped by source_key dedupe. Verified against real statement PDFs at all four year-ends — the draft values appear in no statement.
- **User decisions:** repair all 4 rows with CSV as authority (approved before implementation); headline stays Modified-Dietz-over-summed-values + rendered `isPartial` disclosure — the weighted-blend-of-stored-TWRs rewrite was REJECTED (a blend is not a true portfolio TWR; disclosure beats approximation).
- **Codex refinements adopted:** handoff after deploy; session link kept after doc verification (sessions private-by-default behind login wall; same links already in every commit trailer). Standing rule: never toggle a session on this repo to public visibility.
- **New TODO filed (root enabler):** source_key dedupe treats "same key, different values" as a silent no-op — needs a conflict warning at import. See TODO.md.
- **Deferred (disclosed):** `computeXirr`/`computeRiskMetrics` + 8 `app/api/compute/*` routes still first-id-collapse scopes (latent until a 4th account); minor findings parked in the plan's final review (duplicate-CSV-row double-count, boundsRow unscoped for All-period, `accountId: 0` truthy checks, snapshot-coverage SQL constant duplication).
- **Watch item:** the deploy pipe-masking issue (background `| tail` hid a build failure behind exit 0) — checklist now says to check `PIPESTATUS`/grep for "Build error".

## 4. Uncommitted changes / live-process state (post-deploy)

- Working tree: clean after this commit.
- Live processes: packaged app (new build) on :3099; dev server on :3000 (left running per the user's standing mobile-testing workflow); nightly QA fixer's persistent worktree at `../vanguard-skin-qa-fix` (deliberate, do not remove).
- Live DB: December repair applied; backup at `data/backups/pre-december-snapshot-repair-2026-08-10.db`. LQDT 2026-08-06 close still unrepaired (no daily bar yet — known residual).
- No open PRs; no unmerged qa-* branches.

## 5. Claude session link

https://claude.ai/code/session_01AMAMyF3yFaSJkeicfTbXDf
