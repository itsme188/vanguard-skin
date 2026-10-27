# Session Handoff — for Codex review

**Waiting on:** USER: sign the updated Apple Developer agreement at App Store Connect (Agreements, Tax, and Banking), then run `npm run deploy` — `main` `18747e42` is landed but not installed (decision record `apple-agreement-redeploy`). The decision records `broker-realized-gain-reports` and `tax-preparer-short-term-gift` were not touched. CODEX: a review of the account-failure rule in section 3 is welcome. CLAUDE: nothing.

> Rolling file, overwritten at each session close. Past handoffs: `git log -p docs/HANDOFF.md`.

## 1. Goal and files changed

Goal: after the Anthropic account ran out of credit (2026-10-27, from 05:12 ET), rerun the armed-print prepare work that failed, and make an AI account outage stop spending earnings prep retries, with a visible notice in the Earnings Hub.

Commits on `main`:
- `a0dc64b8` fix(earnings): an AI account outage never spends a prep retry; the Earnings Hub says AI prep is paused
  - `lib/earnings/ai-unavailable.ts` (new): `accountFailureOf` (reads `cause` first, over `classifyEnrichmentError`), the pending reason prefix, the `earnings_ai_unavailable` settings marker, `getAiPrepPause` (hub read model), `aiPrepPauseNotice` (wording).
  - `lib/earnings/prepare-armed-event.ts`: pending outcome gains `accountFailure`; step definitions gain `usesAi`; a thrown account-level failure books pending with no attempt unless the runner's deadline fired; marker set and cleared.
  - `lib/earnings/prepare-steps/newsletter-rescan.ts`: account failure releases the claim with no attempt and stops the pass.
  - `lib/earnings/prepare-steps/newsletter-synthesis.ts`: account failure returns pending.
  - `lib/earnings/extract-newsletter-bogeys.ts`: provider error kept on `cause`; no text-only resend on an account-level 400.
  - `app/dashboard/today/EarningsHub.tsx`: `role="status"` "AI paused" line.
  - `tests/earnings/ai-unavailable.test.ts`, `tests/earnings/prepare-ai-account-failure.test.ts` (new).
- `18747e42` chore(claude): `CLAUDE.md`, `docs/DECISIONS.md` (2026-10-27 entry), `docs/reference/earnings-pipeline.md` (§An AI account outage waits), `docs/plans/TODO.md`.

## 2. Checks

- `bash scripts/verify.sh full --base main`: passed at `a0dc64b8` (worktree) and at `18747e42` (main checkout): 1,510 files, 18,958 tests passed, 4 skipped, 9 todo.
- `npx tsc --noEmit`: clean.
- Browser check on a task sandbox (own DB copy, outage state seeded into the copy): the notice renders in light and dark themes and at phone width, no horizontal scroll, no console errors.
- Deploy (`npm run deploy --commit 18747e42`): FAILED at notarization, HTTP 403 "A required agreement is missing or has expired" (same as the nightly fixer that morning). Build, signing and bundle gate passed. Not retried, per the project note on this error.

## 3. Concerns, rejected approaches, decisions

- Owner ruling: an account-level AI failure in the prepare pipeline costs no attempt; article-level and unknown failures count as before. Same classifier as the research feed, no second one.
- Claude's calls: the rescan stops at the first account failure (not the research feed's two-in-a-row rule). A step cut off by the runner's own deadline still counts (its AbortError would otherwise read as "network"). The marker clears only when an AI step finishes or fails, never on a plain pending. The notice shows on every week the hub displays.
- Live repair: the owner ran a one-off backed-up script resetting the outage's spent scan rows and failed steps to zero attempts; Claude's own live write was blocked by the permission classifier. The next passes completed every scan and deep read.
- Open (TODO top): whether price-level extraction and the earnings-date check also spend retries on an outage; same-day arms still get no local preview email, so the worksheet auto-print waits.

## 4. State after closeout

- The installed app is the PREVIOUS build (deploy failed before install); :3099 is up.
- `main` = `origin/main` = this handoff commit. The push also carried three nightly-fixer commits that were already on local `main` (`25353486`, `22d86b1d`, `eff9995e`); they are likewise not installed.
- Worktree `/Users/Yitzi/code/vanguard-skin-ai-outage` (branch `ai-account-failure-no-retry-burn`, merged) is left for the owner to remove; `/Users/Yitzi/code/vanguard-skin-qa-fix` belongs to the nightly fixer. Task sandbox stopped (evidence kept).
- Open PRs #124 to #127 are nightly QA branches, not from this session.

## 5. Agent

Claude Code (Opus 5.5). Session: https://claude.ai/code/session_019QYEpY4p8Buh95qRRK76Zn
