# Session Handoff — for Codex review

**Waiting on:** USER: on the next print armed under two hours before its release, confirm the preview email arrived and the sheet then auto-printed (decision record `late-arm-preview-confirm`). The decision records `broker-realized-gain-reports` and `tax-preparer-short-term-gift` were not touched. CODEX: a review of `isLateArmPreviewInWindow` and the send-time re-check (section 3) is welcome. CLAUDE: nothing.

> Rolling file, overwritten at each session close. Past handoffs: `git log -p docs/HANDOFF.md`.

## 1. Goal and files changed

Goal: install the 2026-10-27 outage fix (blocked on the Apple agreement), then close the two TODO items it left: (A) a print armed after its 105-135 minute preview window still gets its preview, so the auto-print can fire; (B) the daily earnings-date check retries after an AI account outage instead of losing the day.

Commits on `main`:
- `2fef7020` fix(earnings): a late arm gets its preview; the date check retries an AI outage
  - `lib/calendar/enrichment-runner.ts`: `LATE_ARM_PREVIEW_CUTOFF_MS`, `isLateArmPreviewInWindow`, armed flag in the preview query (LEFT JOIN `earnings_worksheet_flags`), `EmailCandidate.lateArm`.
  - `lib/calendar/email-sweep.ts`: per-candidate body extracted verbatim into `processSweepCandidate`; `runLateArmPreviewKick`; skip `late-arm-window-closed`.
  - `lib/earnings/worksheet.ts`: `printArmedWorksheets` passes serialized in-process (promise queue).
  - `app/api/earnings/worksheet/route.ts`: arm chains the kick after the prepare pass.
  - `lib/calendar/verify-earnings-dates.ts`: `accountFailure` on the result; the day stamp is restored on one.
  - `lib/earnings/ai-unavailable.ts`: `accountFailureOf` also reads raw `@anthropic-ai/sdk` errors.
  - Tests: `tests/calendar/late-arm-preview.test.ts`, `tests/api/earnings-worksheet-late-arm-kick.test.ts` (new); `tests/earnings/worksheet.test.ts`, `tests/calendar/verify-earnings-dates.test.ts`, `tests/earnings/ai-unavailable.test.ts` (extended).
- `31f61c7f` chore(claude): `CLAUDE.md`, `docs/DECISIONS.md` (2026-10-28 entry), `docs/reference/earnings-pipeline.md` (§Late-arm preview, outage section), `docs/plans/TODO.md`.
- `7621dfd9` fix(earnings): review fixes (never earlier than the regular window; re-check at send; client timeout is not an account failure).
- `b160461f` chore(earnings): one log line per kick.
- `46b20581` docs: TODO reconciled with hashes.

## 2. Checks

- `bash scripts/verify.sh full --base main` at `46b20581` (main checkout): 18,999 tests passed.
- `npx tsc --noEmit`: clean.
- Sandbox end to end (own DB copy, :3090, dummy AI key, no email recipient): a hand-entered event armed through the Hub button inside the late window; the log showed the rescan pending with no attempt, the kick running (refused `not-ready`: no recipient in the sandbox), and the worksheet waiting for a local preview. Hub showed the "AI paused" notice; no console errors.
- Opus review of the branch: three real defects found and fixed in `7621dfd9`.
- Deploys: `2c8edf33` (the outage fix plus three nightly-fixer commits) and then `46b20581` via `npm run deploy`, both notarized, installed and relaunched; post-deploy checks passed.

## 3. Concerns, rejected approaches, decisions

- Owner chose option A (late arm triggers its preview) over leaving the auto-print without a preview.
- Claude's calls: a late-arm preview never sends earlier than the regular window would have (only after it has closed on the recorded release instant); the cut-off is 15 minutes before the earlier of the release instant and the slot floor; the window is re-checked at send, so a queued kick cannot mail after the print. A client timeout is not an account failure (it would otherwise retry the date check all day).
- Print-watch Go is deliberately not wired to the kick.
- Known limit: a sweep tick landing mid-prepare composes without the deep read. The Worker is unchanged (Mac only).
- Not seen live: a real late-arm email (the sandbox has no recipient).

## 4. State after closeout

- Installed app: `46b20581`, :3099 up.
- `main` = `origin/main` = this handoff commit. Worktree `vanguard-skin-late-arm` and its branch removed.
- Other worktrees: `/Users/Yitzi/code/vanguard-skin-fund-style` (branch `fund-style-growth-value`, not this session) and `/Users/Yitzi/code/vanguard-skin-qa-fix` (nightly fixer). Open PRs #124 to #128 are nightly QA branches.
- No dev servers or sandboxes running.

## 5. Agent

Claude Code (Opus 5.5). Session: https://claude.ai/code/session_019QYEpY4p8Buh95qRRK76Zn
